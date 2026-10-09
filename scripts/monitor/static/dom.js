// Tiny DOM builders. Everything the page shows from the log goes through text nodes, never through markup strings.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  decorate(el, props);
  append(el, children);
  return el;
}

const SVG = "http://www.w3.org/2000/svg";
export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG, tag);
  decorate(el, props);
  append(el, children);
  return el;
}

function decorate(el, props) {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "vars") for (const [name, value] of Object.entries(v)) el.style.setProperty(name, String(value));
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function replace(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}
