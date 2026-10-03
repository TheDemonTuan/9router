#!/usr/bin/env python3
"""Native, build-time-only full-client closure; no release binaries or runtime fetches."""
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile


LOCK_DIR = pathlib.Path(__file__).with_name("tunnel-build-lock")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def fetch(asset):
    if not asset["url"].startswith(("https://codeload.github.com/", "https://proxy.golang.org/", "https://go.dev/dl/")):
        raise ValueError("Unreviewed build acquisition host")
    with urllib.request.urlopen(asset["url"], timeout=180) as response:
        if not response.url.startswith("https://"):
            raise ValueError("Build asset redirected away from HTTPS")
        data = response.read()
    if sha256(data) != asset["sha256"]:
        raise ValueError("Build asset SHA256 mismatch: " + asset["url"])
    return data


def lock_hash():
    # Hash paths as well as contents; no omitted/untracked input can join the build.
    records = {p.relative_to(LOCK_DIR).as_posix(): sha256(p.read_bytes())
               for p in sorted(LOCK_DIR.rglob("*")) if p.is_file()}
    return sha256(json.dumps(records, sort_keys=True, separators=(",", ":")).encode())


def extract_source(asset, destination):
    with zipfile.ZipFile(io.BytesIO(fetch(asset))) as archive:
        names = archive.namelist()
        expected = set(asset["members"]) | set(asset["directories"])
        if len(names) != len(set(names)) or set(names) != expected:
            raise ValueError("Source ZIP closure differs from reviewed complete inventory")
        for name in names:
            path = pathlib.PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or "\\" in name or not name.startswith(asset["prefix"]):
                raise ValueError("Unsafe source archive member")
            if name.endswith("/"):
                continue
            data = archive.read(name)
            if sha256(data) != asset["members"][name]:
                raise ValueError("Source ZIP member hash mismatch: " + name)
            output = destination / name[len(asset["prefix"]):]
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(data)


def extract_toolchain(asset, destination):
    with tarfile.open(fileobj=io.BytesIO(fetch(asset)), mode="r:gz") as archive:
        seen = set()
        for member in archive.getmembers():
            path = pathlib.PurePosixPath(member.name)
            if (path.is_absolute() or ".." in path.parts or "\\" in member.name
                    or path.parts[0] != "go" or member.name in seen
                    or not (member.isfile() or member.isdir())):
                raise ValueError("Unsafe Go distribution member")
            seen.add(member.name)
            output = destination / member.name
            if member.isdir():
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(archive.extractfile(member).read())
                output.chmod(member.mode & 0o777)
    return destination / "go"


def decode_stream(text):
    decoder = json.JSONDecoder()
    rows = []
    while text.strip():
        row, end = decoder.raw_decode(text.lstrip())
        rows.append(row)
        text = text.lstrip()[end:]
    return rows


def command(go, env, source, *args):
    return subprocess.check_output([str(go), *args], cwd=source, env=env, text=True)


def acquire_modules(go, env, source, name):
    expected = json.loads((LOCK_DIR / name / "modules.json").read_text())
    before = {f: sha256((source / f).read_bytes()) for f in ("go.mod", "go.sum")}
    rows = decode_stream(command(go, env, source, "mod", "download", "-json", "all"))
    actual = [{k: r[k] for k in ("Path", "Version", "Sum", "GoModSum") if k in r} for r in rows]
    if actual != expected or any("Error" in r for r in rows):
        raise ValueError("Downloaded module graph differs from pinned checksum lock: " + name)
    command(go, env, source, "mod", "verify")
    if any(sha256((source / f).read_bytes()) != before[f] for f in before):
        raise ValueError("Go modified the readonly dependency lock")
    return {(r["Path"], r["Version"]): r for r in rows}


def binary_modules(go, env, source, binary):
    text = command(go, env, source, "version", "-m", str(binary))
    modules = []
    for line in text.splitlines()[1:]:
        fields = line.strip().split("\t")
        if fields[0] in ("mod", "dep"):
            modules.append({"kind": fields[0], "Path": fields[1], "Version": fields[2],
                            "Sum": fields[3] if len(fields) > 3 else ""})
        elif fields[0] == "=>":
            modules[-1]["Replace"] = {"Path": fields[1], "Version": fields[2],
                                       "Sum": fields[3] if len(fields) > 3 else ""}
    if not modules or modules[0]["kind"] != "mod":
        raise ValueError("Binary lost its Go module build metadata")
    return text, modules


def collect_licenses(source, key, output):
    evidence = []
    for path in sorted(source.rglob("*")):
        if not path.is_file() or not re.match(r"^(licen[cs]e|copying|copyright|notice)([.\-_]|$)", path.name, re.I):
            continue
        relative = path.relative_to(source).as_posix()
        content = path.read_bytes()
        destination = output / "dependency-licenses" / key / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        evidence.append((destination.relative_to(output).as_posix(), content))
    if not evidence:
        raise ValueError("Missing source license evidence: " + key)
    return evidence


def write_sbom(name, binary, modules, downloads, source, goroot, output, settings):
    packages, relationships, license_infos = [], [], []
    evidence_records = []
    all_modules = modules + [{"kind": "stdlib", "Path": "stdlib", "Version": settings["goVersion"].removeprefix("go")}]
    for index, original in enumerate(all_modules):
        module = original.get("Replace", original)
        module = dict(module)
        if original["kind"] == "mod":
            module["Version"] = settings["version"]
            module_source = source
            download_url = settings["sourceUrl"]
            source_info = "Patched pinned source; original source SHA256 " + settings["sourceSha256"]
        elif original["kind"] == "stdlib":
            module_source = goroot
            download_url = settings["goUrl"]
            source_info = "Official Go distribution SHA256 " + settings["goSha256"]
        else:
            record = downloads.get((module["Path"], module["Version"]))
            if record is None or record["Sum"] != module["Sum"]:
                raise ValueError("Linked binary dependency absent from locked graph: " + module["Path"])
            module_source = pathlib.Path(record["Dir"])
            escaped_path = "".join("!" + char.lower() if "A" <= char <= "Z" else char for char in module["Path"])
            download_url = "https://proxy.golang.org/" + escaped_path + "/@v/" + module["Version"] + ".zip"
            source_info = "Go checksum database verified module " + record["Sum"] + "; go.mod " + record["GoModSum"]
            if "Replace" in original:
                source_info += "; replaces " + original["Path"] + "@" + original["Version"]
        key = sha256((module["Path"] + "@" + module["Version"]).encode())[:16]
        evidence = collect_licenses(module_source, key, output)
        license_ids = []
        for relative, content in evidence:
            license_id = "LicenseRef-" + sha256(content)
            license_ids.append(license_id)
            if not any(item["licenseId"] == license_id for item in license_infos):
                license_infos.append({"licenseId": license_id, "extractedText": content.decode("utf-8", errors="replace"),
                                      "name": pathlib.PurePosixPath(relative).name})
            evidence_records.append({"module": module["Path"], "version": module["Version"],
                                     "file": relative, "sha256": sha256(content)})
        package_id = "SPDXRef-Package-" + str(index)
        package = {"SPDXID": package_id, "name": module["Path"], "versionInfo": module["Version"],
                   "downloadLocation": download_url, "filesAnalyzed": False,
                   "licenseConcluded": "NOASSERTION", "licenseDeclared": "NOASSERTION",
                   "copyrightText": "NOASSERTION", "sourceInfo": source_info,
                   "externalRefs": [{"referenceCategory": "PACKAGE-MANAGER", "referenceType": "purl",
                                     "referenceLocator": "pkg:golang/" + module["Path"] + "@" + module["Version"]}],
                   "comment": "License evidence (" + ", ".join(sorted(set(license_ids))) + "): "
                              + ", ".join(relative for relative, _ in evidence)}
        packages.append(package)
        relationships.append({"spdxElementId": "SPDXRef-Binary", "relationshipType": "DEPENDS_ON",
                              "relatedSpdxElement": package_id})
    digest = sha256(binary.read_bytes())
    document = {"spdxVersion": "SPDX-2.3", "dataLicense": "CC0-1.0", "SPDXID": "SPDXRef-DOCUMENT",
                "name": name + " native patched closure", "documentNamespace": "https://9router.invalid/spdx/" + name + "/" + digest,
                "creationInfo": {"created": "2026-10-03T00:00:00Z", "creators": ["Tool: cgw-native-tunnel-builder"]},
                "documentDescribes": ["SPDXRef-Binary"], "packages": packages,
                "files": [{"SPDXID": "SPDXRef-Binary", "fileName": "/usr/local/bin/" + name,
                           "checksums": [{"algorithm": "SHA256", "checksumValue": digest}],
                           "licenseConcluded": "NOASSERTION", "licenseInfoInFiles": ["NOASSERTION"],
                           "copyrightText": "NOASSERTION"}],
                "relationships": relationships, "hasExtractedLicensingInfos": license_infos}
    (output / (name + ".spdx.json")).write_text(json.dumps(document, indent=2) + "\n")
    (output / (name + "-licenses.json")).write_text(json.dumps(evidence_records, indent=2) + "\n")


def build(manifest, arch, root, revision):
    settings = manifest["tunnel"]["sourceBuild"]
    if lock_hash() != settings["inputLockSha256"]:
        raise ValueError("Committed source/dependency lock digest mismatch")
    if sha256(pathlib.Path(__file__).read_bytes()) != settings["buildHelperSha256"]:
        raise ValueError("Native build helper differs from reviewed manifest")
    sources = json.loads((LOCK_DIR / "sources.json").read_text())
    toolchain = manifest["buildToolchain"]
    asset = toolchain["platforms"][arch]
    binaries = root / "bin"
    licenses = root / "share/licenses/tunnel-client"
    binaries.mkdir(parents=True, exist_ok=True)
    licenses.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cgw-native-build-") as directory:
        work = pathlib.Path(directory)
        goroot = extract_toolchain(asset, work)
        go = goroot / "bin/go"
        env = os.environ.copy()
        env.update({"GOROOT": str(goroot), "GOTOOLCHAIN": "local", "GOWORK": "off",
                    "GOPATH": str(work / "gopath"), "GOCACHE": str(work / "gocache"),
                    "GOMODCACHE": str(work / "gopath/pkg/mod"), "GOPROXY": "https://proxy.golang.org",
                    "GOSUMDB": "sum.golang.org", "GONOPROXY": "none", "GONOSUMDB": "none",
                    "GOOS": "linux", "GOARCH": arch, "CGO_ENABLED": "0", "GOFLAGS": "",
                    "GOEXPERIMENT": "", "GOENV": "off", "GOAMD64": "v1", "GOARM64": "v8.0"})
        if command(go, env, work, "version").strip() != "go version " + toolchain["version"] + " linux/" + arch:
            raise ValueError("Unexpected native build toolchain")
        for name in ("tunnel-client", "cloudflared"):
            source = work / name
            extract_source(sources[name], source)
            for file in ("go.mod", "go.sum"):
                shutil.copyfile(LOCK_DIR / name / file, source / file)
            downloads = acquire_modules(go, env, source, name)
            binary = binaries / name
            if name == "tunnel-client":
                flags = "-X github.com/openai/tunnel-client/pkg/version.GitSHA=" + manifest["tunnel"]["revision"]
                flags += " -X github.com/openai/tunnel-client/pkg/version.semanticVersion=" + manifest["tunnel"]["version"]
                flags += " -X github.com/openai/tunnel-client/pkg/version.GoVersion=" + toolchain["version"]
                flags += " -X github.com/openai/tunnel-client/pkg/version.Flavor=full"
                package = "./cmd/client"
                version = manifest["tunnel"]["version"]
            else:
                cloud = manifest["tunnel"]["cloudflared"]
                flags = "-X main.Version=" + cloud["version"] + " -X main.BuildTime=" + cloud["build_time"]
                package = "./cmd/cloudflared"
                version = cloud["version"]
            command(go, env, source, "build", "-mod=readonly", "-trimpath", "-buildvcs=false",
                    "-ldflags", flags, "-o", str(binary), package)
            binary.chmod(0o755)
            content = binary.read_bytes()
            machine = {"amd64": 62, "arm64": 183}[arch]
            if content[:6] != b"\x7fELF\x02\x01" or int.from_bytes(content[18:20], "little") != machine:
                raise ValueError("Rebuilt tunnel closure has wrong ELF architecture")
            metadata, modules = binary_modules(go, env, source, binary)
            linked = {m.get("Replace", m)["Path"]: m.get("Replace", m)["Version"] for m in modules}
            for dependency, required_version in settings["dependencyVersions"][name].items():
                if linked.get(dependency) != required_version:
                    raise ValueError("Required patched dependency not linked: " + dependency)
            for file in ("go.mod", "go.sum"):
                if (source / file).read_bytes() != (LOCK_DIR / name / file).read_bytes():
                    raise ValueError("Build changed the committed dependency lock")
            (licenses / (name + "-go-buildinfo.txt")).write_text(metadata)
            write_sbom(name, binary, modules, downloads, source, goroot, licenses,
                       {"version": version, "sourceUrl": sources[name]["url"], "sourceSha256": sources[name]["sha256"],
                        "goVersion": toolchain["version"], "goUrl": asset["url"], "goSha256": asset["sha256"]})
            for file in ("LICENSE", "NOTICE"):
                if (source / file).is_file():
                    shutil.copyfile(source / file, licenses / (file if name == "tunnel-client" else name + "-" + file))
            for file in ("go.mod", "go.sum", "modules.json"):
                shutil.copyfile(LOCK_DIR / name / file, licenses / (name + "-" + file))
    shutil.copyfile(LOCK_DIR / "sources.json", licenses / "sources.json")
    (licenses / "cloudflared-manifest.json").write_text(json.dumps(manifest["tunnel"]["cloudflared"], indent=2) + "\n")
    provenance = {"schemaVersion": 1, "appRevision": revision, "architecture": "linux/" + arch,
                  "inputLockSha256": settings["inputLockSha256"], "tunnelRevision": manifest["tunnel"]["revision"],
                  "cloudflaredRevision": manifest["tunnel"]["cloudflared"]["release_commit"],
                  "goVersion": toolchain["version"], "goArchiveSha256": asset["sha256"],
                  "sourceArchives": {name: {key: asset[key] for key in ("url", "sha256")}
                                     for name, asset in sources.items()},
                  "buildHelperSha256": sha256(pathlib.Path(__file__).read_bytes()),
                  "dependencyVersions": settings["dependencyVersions"],
                  "nativeBuild": True, "flavor": "full", "cgoEnabled": False,
                  "files": {p.relative_to(root).as_posix(): sha256(p.read_bytes())
                            for folder in (binaries, licenses) for p in sorted(folder.rglob("*")) if p.is_file()}}
    (licenses / "build-provenance.json").write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n")
