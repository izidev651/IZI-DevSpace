// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Content-side half of IZI DevSpace: Fake Fill and the page operations used by
// the MCP server (read text, list interactive elements, click, type, keys,
// scroll, evaluate). Input is dispatched as trusted events (windowUtils /
// nsITextInputProcessor) so pages react exactly as they would to a user.

const FIRSTS = ["Andi", "Budi", "Citra", "Dewi", "Eka", "Fajar", "Gita", "Hendra", "Intan", "Joko", "Sarah", "Michael", "Emma", "Liam"];
const LASTS = ["Pratama", "Wijaya", "Saputra", "Lestari", "Santoso", "Hidayat", "Kusuma", "Nugroho", "Smith", "Johnson"];
const CITIES = ["Jakarta", "Bandung", "Surabaya", "Yogyakarta", "Medan", "Denpasar", "Semarang", "Makassar"];
const STREETS = ["Jl. Sudirman", "Jl. Thamrin", "Jl. Gatot Subroto", "Jl. Diponegoro", "Jl. Merdeka", "Jl. Asia Afrika"];
const COMPANIES = ["PT Maju Jaya", "CV Sinar Abadi", "PT Nusantara Digital", "Acme Corp", "Globex Ltd"];
const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore".split(" ");
const INTERACTIVE =
  'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="option"], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
const sentence = (n) => {
  const s = Array.from({ length: n }, () => pick(WORDS)).join(" ");
  return s[0].toUpperCase() + s.slice(1) + ".";
};

export class IZIDevSpaceChild extends JSWindowActorChild {
  async receiveMessage({ name, data }) {
    switch (name) {
      case "IZI:FakeFill":
        return this.fakeFill();
      case "IZI:PageText":
        return this.pageText(data?.maxChars);
      case "IZI:Snapshot":
        return this.snapshot();
      case "IZI:Click":
        return this.click(data);
      case "IZI:Type":
        return this.type(data);
      case "IZI:Key":
        return this.key(data);
      case "IZI:Scroll":
        return this.scroll(data);
      case "IZI:Eval":
        return this.evaluate(data);
      case "IZI:Exists":
        return !!this.document.querySelector(String(data?.selector || ""));
      case "IZI:Metrics": {
        const d = this.document.documentElement;
        return { width: Math.max(d.scrollWidth, this.contentWindow.innerWidth), height: Math.max(d.scrollHeight, this.contentWindow.innerHeight) };
      }
      default:
        return null;
    }
  }

  // ------------------------------------------------------------ Fake Fill
  #labelOf(el) {
    const doc = this.document;
    let t = [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete, el.className].join(" ");
    if (el.id) {
      const l = doc.querySelector(`label[for="${this.contentWindow.CSS.escape(el.id)}"]`);
      if (l) t += " " + l.textContent;
    }
    const pl = el.closest("label");
    if (pl) t += " " + pl.textContent;
    return t.toLowerCase();
  }

  #valueFor(el, person) {
    const type = (el.type || "text").toLowerCase();
    const l = this.#labelOf(el);
    const has = (...k) => k.some((x) => l.includes(x));
    if (type === "email" || has("email", "e-mail", "surel")) return person.email;
    if (type === "password" || has("password", "sandi")) return person.password;
    if (type === "tel" || has("phone", "tel", "mobile", "hp", "telepon", "whatsapp")) return person.phone;
    if (type === "url" || has("website", "url", "homepage")) return person.url;
    if (type === "date") return new Date(Date.now() - (20 + Math.random() * 20) * 365 * 864e5).toISOString().slice(0, 10);
    if (type === "datetime-local") return new Date().toISOString().slice(0, 16);
    if (type === "time") return "09:30";
    if (type === "month") return new Date().toISOString().slice(0, 7);
    if (type === "week") return `${new Date().getFullYear()}-W10`;
    if (type === "color") return "#1fc7b6";
    if (type === "number" || type === "range") {
      const min = el.min !== "" ? Number(el.min) : 1;
      const max = el.max !== "" ? Number(el.max) : Math.max(min + 99, 100);
      return String(Math.floor(min + Math.random() * (max - min + 1)));
    }
    if (has("card", "cc-number", "kartu")) return "4242 4242 4242 4242";
    if (has("cvc", "cvv", "csc")) return "123";
    if (has("exp")) return "12/30";
    if (has("first", "given", "depan", "fname")) return person.first;
    if (has("last", "family", "surname", "belakang", "lname")) return person.last;
    if (has("user", "login", "nick")) return person.user;
    if (has("full name", "fullname", "nama lengkap") || /\bname\b|nama/.test(l)) return person.full;
    if (has("company", "organization", "organisation", "perusahaan")) return person.company;
    if (has("address", "street", "alamat", "addr")) return person.street;
    if (has("city", "kota", "town")) return person.city;
    if (has("zip", "postal", "postcode", "kode pos")) return person.zip;
    if (has("country", "negara")) return "Indonesia";
    if (has("state", "province", "provinsi")) return "DKI Jakarta";
    if (has("age", "umur", "usia")) return String(20 + Math.floor(Math.random() * 30));
    if (has("search", "cari", "query")) return "";
    if (el.localName === "textarea") return sentence(18);
    return sentence(3).slice(0, -1);
  }

  #fire(el, type) {
    el.dispatchEvent(new this.contentWindow.Event(type, { bubbles: true }));
  }

  // Setting .value through the Xray wrapper calls the native setter, which is
  // what frameworks like React need to notice the change.
  #setValue(el, v) {
    el.value = v;
    this.#fire(el, "input");
    this.#fire(el, "change");
  }

  #visible(el) {
    const r = el.getBoundingClientRect();
    const cs = this.contentWindow.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  }

  fakeFill() {
    const first = pick(FIRSTS);
    const last = pick(LASTS);
    const user = `${first}.${last}`.toLowerCase() + digits(2);
    const person = {
      first, last, user,
      full: `${first} ${last}`,
      email: `${user}@example.com`,
      phone: `+62 8${digits(2)}-${digits(4)}-${digits(4)}`,
      company: pick(COMPANIES),
      city: pick(CITIES),
      zip: digits(5),
      street: `${pick(STREETS)} No. ${1 + Math.floor(Math.random() * 200)}`,
      password: `Test@${digits(6)}Aa`,
      url: `https://example.com/${user}`,
    };
    let count = 0;
    const radios = new Set();
    const els = Array.from(this.document.querySelectorAll('input, textarea, select, [contenteditable="true"]'));
    for (const el of els) {
      try {
        if (el.disabled || el.readOnly) continue;
        const type = (el.type || "").toLowerCase();
        if (["hidden", "submit", "button", "reset", "image", "file"].includes(type)) continue;
        if (!this.#visible(el) && type !== "checkbox" && type !== "radio") continue;
        if (el.isContentEditable && !("value" in el)) {
          el.textContent = sentence(10);
          this.#fire(el, "input");
          count++;
          continue;
        }
        if (el.localName === "select") {
          const opts = Array.from(el.options).filter((o) => !o.disabled && o.value !== "");
          if (opts.length) {
            this.#setValue(el, pick(opts).value);
            count++;
          }
          continue;
        }
        if (type === "checkbox") {
          if (!el.checked && (el.required || Math.random() > 0.4)) {
            el.click();
            count++;
          }
          continue;
        }
        if (type === "radio") {
          if (!el.name || radios.has(el.name)) continue;
          radios.add(el.name);
          const group = els.filter((x) => x.type === "radio" && x.name === el.name && !x.disabled);
          const choice = pick(group);
          if (choice && !choice.checked) choice.click();
          count++;
          continue;
        }
        const v = this.#valueFor(el, person);
        if (v === "") continue;
        this.#setValue(el, el.maxLength > 0 ? v.slice(0, el.maxLength) : v);
        count++;
      } catch (e) {
        // keep filling the rest
      }
    }
    return count;
  }

  // --------------------------------------------------------------- reading
  pageText(maxChars = 20000) {
    const text = (this.document.body?.innerText || "").replace(/\n{3,}/g, "\n\n");
    return {
      title: this.document.title,
      url: this.document.location.href,
      text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]` : text,
    };
  }

  snapshot() {
    const doc = this.document;
    for (const e of doc.querySelectorAll("[data-izi-ref]")) e.removeAttribute("data-izi-ref");
    const out = [];
    let i = 1;
    for (const el of doc.querySelectorAll(INTERACTIVE)) {
      if (!this.#visible(el) || el.disabled) continue;
      el.setAttribute("data-izi-ref", String(i));
      const role = el.getAttribute("role") || el.localName + (el.type ? `[${el.type}]` : "");
      const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || el.alt || el.name || "")
        .replace(/\s+/g, " ").trim().slice(0, 80);
      const href = el.localName === "a" ? ` -> ${String(el.getAttribute("href")).slice(0, 100)}` : "";
      const r = el.getBoundingClientRect();
      const off = r.bottom > 0 && r.top < this.contentWindow.innerHeight ? "" : " (offscreen)";
      out.push(`[${i}] ${role} "${label}"${href}${off}`);
      if (++i > 400) break;
    }
    return { title: doc.title, url: doc.location.href, elements: out };
  }

  #find(target) {
    const sel = target?.ref != null ? `[data-izi-ref="${Number(target.ref)}"]` : String(target?.selector || "");
    const el = sel ? this.document.querySelector(sel) : null;
    if (!el) throw new Error("Element not found — run snapshot again");
    el.scrollIntoView({ block: "center", inline: "center" });
    return el;
  }

  // ----------------------------------------------------------------- input
  click(target) {
    const el = this.#find(target);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const utils = this.contentWindow.windowUtils;
    utils.sendMouseEvent("mousemove", x, y, 0, 0, 0);
    utils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
    utils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
    return { clicked: el.localName, url: this.document.location.href, title: this.document.title };
  }

  #tip() {
    const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    if (!tip.beginInputTransactionForTests(this.contentWindow)) throw new Error("Could not start text input");
    return tip;
  }

  #keyEvent(key) {
    const named = key.length > 1;
    const init = { key };
    if (named) init.code = key;
    return new this.contentWindow.KeyboardEvent("", init);
  }

  type({ ref, selector, text, clear = true, submit = false }) {
    const el = this.#find({ ref, selector });
    el.focus();
    if (clear) {
      if ("value" in el && typeof el.select === "function") el.select();
      else this.document.execCommand("selectAll");
    }
    const tip = this.#tip();
    tip.commitCompositionWith(String(text ?? ""));
    if (submit) {
      const ev = this.#keyEvent("Enter");
      tip.keydown(ev);
      tip.keyup(ev);
    }
    return "typed";
  }

  key({ key }) {
    const tip = this.#tip();
    const ev = this.#keyEvent(String(key));
    tip.keydown(ev);
    tip.keyup(ev);
    return `pressed ${key}`;
  }

  scroll({ direction, amount }) {
    const w = this.contentWindow;
    const step = amount || w.innerHeight * 0.85;
    if (direction === "up") w.scrollBy(0, -step);
    else if (direction === "down") w.scrollBy(0, step);
    else if (direction === "top") w.scrollTo(0, 0);
    else if (direction === "bottom") w.scrollTo(0, this.document.documentElement.scrollHeight);
    return { y: Math.round(w.scrollY), max: this.document.documentElement.scrollHeight - w.innerHeight };
  }

  // Runs with the page's own principal (not chrome privileges), unaffected by the
  // page CSP. The result is passed back as JSON.
  async evaluate({ expression }) {
    const win = this.contentWindow;
    const sb = Cu.Sandbox(win, { sandboxPrototype: win, wantXrays: false, sameZoneAs: win, sandboxName: "IZI evaluate" });
    const code = `(async () => { const __r = await (async () => (${expression}))(); try { return JSON.stringify(__r === undefined ? null : __r); } catch (e) { return JSON.stringify(String(__r)); } })()`;
    const json = await Cu.evalInSandbox(code, sb);
    return JSON.parse(json ?? "null");
  }
}
