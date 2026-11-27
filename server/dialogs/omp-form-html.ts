/**
 * The radio and checkbox groups of an omp 19 `ask` form, read from the call's HTML as omp builds them (pi-tui
 * `html-form` HtmlFormBuilder, omp 19.1.1): grouped by type and name in document order, each option labelled by the
 * text of the `<label>` around it, else by the `<label for>` naming it, else by its `aria-label` or `title`, else by its
 * value. omp adds Other to a group of two or more options when none of their labels starts with "other".
 */
export interface FormChoiceGroup {
  multi: boolean;
  labels: string[];
  /** a disabled option: how omp draws it is not measured, so the group's rows are not counted on */
  disabled: boolean;
  other: boolean;
}

/** elements whose text is no label's: a form control's own text, a drawing, a script */
const SKIPPED = new Set(["select", "textarea", "svg", "script", "style", "template"]);
/** block elements omp separates from the text around them */
const SPACED = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/** HTMLRewriter hands text and attribute values over as written: entities stay encoded */
function decode(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (all, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    const code = decimal !== undefined ? Number(decimal) : hex !== undefined ? Number.parseInt(hex, 16) : null;
    if (code === null) return ENTITIES[name!.toLowerCase()] ?? all;
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

const words = (text: string | null): string => decode(text ?? "").replace(/\s+/gu, " ").trim();

interface Control {
  type: string;
  name: string;
  id: string | null;
  value: string | null;
  named: string | null;
  disabled: boolean;
  /** the `<label>` around it, an index into the labels */
  label: number | null;
}

export function formChoiceGroups(html: string): FormChoiceGroup[] {
  const labels: { text: string; for: string | null }[] = [];
  const controls: Control[] = [];
  const open: number[] = [];
  let skipping = 0;
  const append = (text: string): void => {
    if (skipping > 0) return;
    for (const index of open) labels[index]!.text += text;
  };
  new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName;
        if (tag === "input") {
          controls.push({
            type: (element.getAttribute("type") ?? "text").toLowerCase(), name: element.getAttribute("name") ?? "", id: element.getAttribute("id"),
            value: element.getAttribute("value"), named: element.getAttribute("aria-label") ?? element.getAttribute("title"),
            disabled: element.hasAttribute("disabled"), label: open.at(-1) ?? null,
          });
          return;
        }
        if (tag === "img") return append(element.getAttribute("alt") ?? "");
        if (tag === "br") return append("\n");
        if (!element.canHaveContent) return;
        if (SKIPPED.has(tag)) {
          skipping += 1;
          element.onEndTag(() => { skipping -= 1; });
          return;
        }
        if (SPACED.has(tag)) {
          append(" ");
          element.onEndTag(() => append(" "));
        }
        if (tag === "label") {
          const index = labels.push({ text: "", for: element.getAttribute("for") }) - 1;
          open.push(index);
          element.onEndTag(() => { open.splice(open.indexOf(index), 1); });
        }
      },
    })
    .onDocument({ text: (chunk) => append(chunk.text) })
    .transform(html);

  const groups = new Map<string, FormChoiceGroup>();
  for (const control of controls) {
    if (control.type !== "radio" && control.type !== "checkbox") continue;
    const label = words(control.label === null ? null : labels[control.label]!.text)
      || words(control.id === null ? null : labels.find((each) => each.for === control.id)?.text ?? null)
      || words(control.named)
      || words(control.value ?? control.name);
    const key = `${control.type}\u0000${control.name}`;
    const group = groups.get(key) ?? { multi: control.type === "checkbox", labels: [], disabled: false, other: false };
    group.labels.push(label);
    group.disabled ||= control.disabled;
    groups.set(key, group);
  }
  for (const group of groups.values()) group.other = group.labels.length > 1 && !group.labels.some((label) => /^\s*other\b/iu.test(label));
  return [...groups.values()];
}
