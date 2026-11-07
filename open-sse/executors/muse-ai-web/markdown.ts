export interface MuseSnapshot {
  count: number;
  text: string;
  generating: boolean;
}

/** Chụp nội dung đã render và phục hồi cấu trúc Markdown. */
export function readMuseSnapshot(): MuseSnapshot {
  const scrollable = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((element) => {
    const { overflowY } = getComputedStyle(element);
    return (
      (overflowY === "auto" || overflowY === "scroll") &&
      element.scrollHeight > element.clientHeight + 100
    );
  });
  scrollable.sort((left, right) => right.scrollHeight - left.scrollHeight);
  if (scrollable[0]) scrollable[0].scrollTop = scrollable[0].scrollHeight;

  const scope =
    document.querySelector('main,[class*="chat-scroll"],[class*="hatch-chat-scroll"]') ??
    document.body;
  const bubbles = Array.from(
    scope.querySelectorAll<HTMLElement>(
      'div[class*="hatch-chat-groupable-bubble"][class*="hatch-agent-bubble-bg"]'
    )
  ).filter((bubble) => bubble.innerText.trim());
  const generating = Boolean(
    document.querySelector(
      '[data-testid="hatch-composer-stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]'
    )
  );
  const bubble = bubbles.at(-1);
  if (!bubble) return { count: 0, text: "", generating };

  const codeBlocks: string[] = [];
  // Giữ các phương thức tự chứa để Playwright có thể chạy trong trang.
  const renderer = {
    fence(value: string, minimum: number): string {
      const runs = value.match(/`+/g) ?? [];
      const width = runs.reduce((longest, run) => Math.max(longest, run.length + 1), minimum);
      return "`".repeat(width);
    },
    blockCode(element: HTMLElement): string {
      const code = element.querySelector("code");
      const value = (code ?? element).textContent ?? "";
      const language = code?.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1] ?? "";
      const fence = renderer.fence(value, 3);
      const index = codeBlocks.push(
        fence + language + "\n" + value + (value.endsWith("\n") ? "" : "\n") + fence
      );
      return "\n\n\u0000MUSE_CODE_" + (index - 1) + "\u0000\n\n";
    },
    listItem(element: HTMLElement, body: string, depth: number): string {
      const parent = element.parentElement;
      let marker = "- ";
      if (parent?.tagName === "OL") {
        const items = Array.from(parent.children).filter((item) => item.tagName === "LI");
        marker = Number(parent.getAttribute("start") || 1) + items.indexOf(element) + ". ";
      }
      return "\n" + "  ".repeat(Math.max(0, depth - 1)) + marker + body.trim() + "\n";
    },
    render(node: Node, depth: number): string {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
      if (!(node instanceof HTMLElement)) return "";
      const tag = node.tagName;
      if (node.hidden || /^(SCRIPT|STYLE|NOSCRIPT|BUTTON)$/.test(tag)) return "";
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return "";

      const heading = /^H[1-6]$/.test(tag)
        ? Number(tag.slice(1))
        : node.getAttribute("role") === "heading"
          ? Number(node.getAttribute("aria-level"))
          : 0;
      if (Number.isInteger(heading) && heading >= 1 && heading <= 6) {
        return "\n\n" + "#".repeat(heading) + " " + node.innerText.trim() + "\n\n";
      }
      if (tag === "PRE") return renderer.blockCode(node);
      if (tag === "BR") return "\n";
      if (tag === "CODE") {
        const value = node.textContent ?? "";
        const fence = renderer.fence(value, 1);
        const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
        return fence + pad + value + pad + fence;
      }

      const list = tag === "UL" || tag === "OL";
      const children = Array.from(node.childNodes)
        .map((child) => renderer.render(child, list ? depth + 1 : depth))
        .join("");
      if (list) return "\n" + children + "\n";
      if (tag === "LI") return renderer.listItem(node, children, depth);
      if (tag === "STRONG" || tag === "B") return "**" + children + "**";
      if (tag === "EM" || tag === "I") return "*" + children + "*";
      if (tag === "A") {
        const href = node.getAttribute("href");
        return href ? "[" + children + "](" + href + ")" : children;
      }
      if (tag === "BLOCKQUOTE") {
        return (
          "\n\n" +
          children
            .trim()
            .split("\n")
            .map((line) => "> " + line)
            .join("\n") +
          "\n\n"
        );
      }
      return /^(P|DIV|SECTION|ARTICLE|HEADER|FOOTER)$/.test(tag)
        ? "\n\n" + children + "\n\n"
        : children;
    },
  };

  // Chỉ gom dòng trống ở phần văn bản, giữ nguyên khoảng trắng trong code fence.
  const text = renderer
    .render(bubble, 0)
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\u0000MUSE_CODE_(\d+)\u0000/g, (match, index: string) => {
      return codeBlocks[Number(index)] ?? match;
    });
  return { count: bubbles.length, text, generating };
}
