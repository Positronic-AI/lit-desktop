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

/** `baseUrl`: the server the message lives on. A tab standing on app.lit.ai
 *  must resolve `/mux/channel-uploads/…` against app.lit.ai, not the app-active
 *  (local) connection — every image in a remote tab was broken (2026-11-01). */
export function renderMarkdown(text: string, baseUrl?: string): string {
  // Resolve relative image URLs to the server the message lives on
  const serverUrl = (baseUrl || getServer().url).replace(/\/+$/, "");
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
