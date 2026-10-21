// Frame SSE records without re-scanning or repeatedly joining an unfinished
// network fragment. CR, LF and CRLF delimiters may themselves span reads.
export function createSSERecordParser(onRecord) {
  let pieces = [];
  let lines = [];
  let skipLF = false;
  const lineEnd = () => {
    const line = pieces.join("");
    pieces = [];
    if (line === "") {
      if (lines.length) onRecord(lines.join("\n"));
      lines = [];
    } else lines.push(line);
  };
  return {
    write(text) {
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (skipLF) {
          skipLF = false;
          if (code === 10) { start = i + 1; continue; }
        }
        if (code !== 10 && code !== 13) continue;
        if (i > start) pieces.push(text.slice(start, i));
        lineEnd();
        skipLF = code === 13;
        start = i + 1;
      }
      if (start < text.length) pieces.push(text.slice(start));
    },
    end() {
      if (pieces.length) lineEnd();
      if (lines.length) onRecord(lines.join("\n"));
      pieces = [];
      lines = [];
    },
  };
}
