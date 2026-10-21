const ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

// Decode the custom-tool { input: string } envelope once, across arbitrary SSE splits.
// Final JSON validation belongs to the caller; partial output is never executable.
export class ClaudeCustomInputDecoder {
  constructor() {
    this.phase = "open";
    this.key = "";
    this.hex = "";
    this.target = null;
    this.invalid = false;
  }

  push(fragment) {
    const output = [];
    const append = (text) => {
      if (this.target === "key") this.key += text;
      else output.push(text);
    };
    for (const char of fragment) {
      if (this.invalid) break;
      switch (this.phase) {
        case "open":
          if (/\s/.test(char)) break;
          if (char === "{") this.phase = "keyStart";
          else this.invalid = true;
          break;
        case "keyStart":
          if (/\s/.test(char)) break;
          if (char === '"') { this.target = "key"; this.phase = "string"; }
          else this.invalid = true;
          break;
        case "string":
          if (char === '"') {
            if (this.target === "key") {
              if (this.key !== "input") this.invalid = true;
              this.phase = "colon";
            } else this.phase = "close";
          } else if (char === "\\") this.phase = "escape";
          else if (char.charCodeAt(0) < 32) this.invalid = true;
          else append(char);
          break;
        case "escape": {
          if (char === "u") { this.hex = ""; this.phase = "unicode"; }
          else if (Object.hasOwn(ESCAPES, char)) { append(ESCAPES[char]); this.phase = "string"; }
          else this.invalid = true;
          break;
        }
        case "unicode":
          if (!/[0-9a-f]/i.test(char)) { this.invalid = true; break; }
          this.hex += char;
          if (this.hex.length === 4) { append(String.fromCharCode(parseInt(this.hex, 16))); this.phase = "string"; }
          break;
        case "colon":
          if (/\s/.test(char)) break;
          if (char === ":") this.phase = "valueStart";
          else this.invalid = true;
          break;
        case "valueStart":
          if (/\s/.test(char)) break;
          if (char === '"') { this.target = "value"; this.phase = "string"; }
          else this.invalid = true;
          break;
        case "close":
          if (/\s/.test(char)) break;
          if (char === "}") this.phase = "end";
          else this.invalid = true;
          break;
        case "end":
          if (!/\s/.test(char)) this.invalid = true;
          break;
      }
    }
    return output.join("");
  }

  get complete() {
    return !this.invalid && this.phase === "end";
  }
}
