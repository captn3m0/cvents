// Allow-list HTML sanitiser built on the Workers HTMLRewriter.
const DROP = "script,style,iframe,frame,frameset,object,embed,form,input,button,textarea,select,option,svg,math,template,noscript,link,meta,base,video,audio,source,canvas,head,title";
const KEEP = new Set(["p", "br", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li", "a", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "sub", "sup", "hr", "img", "table", "thead", "tbody", "tr", "td", "th", "pre", "code"]);

const handler = {
  element(el) {
    if (el.removed) return;
    if (el.tagName === "h1") el.tagName = "h2";
    if (!KEEP.has(el.tagName)) return el.removeAndKeepContent();
    const href = el.getAttribute("href") ?? "";
    const src = el.getAttribute("src") ?? "";
    const alt = el.getAttribute("alt") ?? "";
    for (const [name] of [...el.attributes]) el.removeAttribute(name);
    if (el.tagName === "a") {
      if (/^https?:\/\//i.test(href)) {
        el.setAttribute("href", href);
        el.setAttribute("rel", "nofollow noopener ugc");
      } else el.removeAndKeepContent();
    } else if (el.tagName === "img") {
      if (!/^https:\/\//i.test(src)) return el.remove();
      el.setAttribute("src", src);
      el.setAttribute("alt", alt);
      el.setAttribute("loading", "lazy");
    }
  },
};

export async function sanitizeHtml(html) {
  if (!html) return "";
  const out = new HTMLRewriter()
    .on(DROP, { element: (el) => el.remove() })
    .on("*", handler)
    .onDocument({ comments: (c) => c.remove(), doctype: () => {} })
    .transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  const text = (await out.text()).trim();
  return /^(<p>(\s|&nbsp;|<br>)*<\/p>\s*)*$/.test(text) ? "" : text;
}

export async function sanitizeModel(data) {
  const jobs = [];
  const walk = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (k.endsWith("Html") && typeof v === "string") jobs.push(sanitizeHtml(v).then((s) => { o[k] = s; }));
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(data);
  await Promise.all(jobs);
  return data;
}
