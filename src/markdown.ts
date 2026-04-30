import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";
import DOMPurify from "dompurify";
import { getServer } from "./api";

const marked = new Marked(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  })
);

marked.setOptions({
  gfm: true,
  breaks: true,
  async: false,
});

export function renderMarkdown(text: string): string {
  // Resolve relative image URLs to the server
  const serverUrl = getServer().url;
  const resolved = text.replace(
    /!\[([^\]]*)\]\((\/mux\/[^)]+)\)/g,
    (_, alt, path) => `![${alt}](${serverUrl}${path})`
  );

  const raw = marked.parse(resolved);
  if (typeof raw !== "string") return "";
  return DOMPurify.sanitize(raw, {
    ADD_TAGS: ["code", "pre", "span", "img"],
    ADD_ATTR: ["class", "src", "alt"],
  });
}
