import DOMPurify from "dompurify";

export async function enhanceMarkdown(body: HTMLElement) {
  const formulas = [...body.querySelectorAll<HTMLElement>(".math-inline,.math-display")].slice(0, 150);
  const code = [...body.querySelectorAll<HTMLElement>("pre > code[class*='language-']")].slice(0, 100);
  await Promise.all([
    formulas.length && import("katex").then(({ default: katex }) => {
      for (const node of formulas) {
        const formula = node.textContent ?? "";
        if (formula.length > 2_000) continue;
        try {
          const math = katex.renderToString(formula, {
            displayMode: node.classList.contains("math-display"),
            output: "mathml",
            maxExpand: 100,
            maxSize: 20,
            trust: false,
          });
          node.replaceChildren(DOMPurify.sanitize(math, { RETURN_DOM_FRAGMENT: true }));
        } catch {
          // Keep the original TeX for unsupported or invalid formulas.
        }
      }
    }),
    code.length && import("highlight.js/lib/common").then(({ default: highlighter }) => {
      for (const node of code) {
        const language = [...node.classList].find((item) => item.startsWith("language-"))?.slice(9);
        const source = node.textContent ?? "";
        if (!language || !highlighter.getLanguage(language) || source.length > 24_000) continue;
        const highlighted = highlighter.highlight(source, { language, ignoreIllegals: true }).value;
        node.replaceChildren(DOMPurify.sanitize(highlighted, { RETURN_DOM_FRAGMENT: true }));
        node.classList.add("hljs");
      }
    }),
  ]);
}
