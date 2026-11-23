"use strict";
(function(){
  const $ = id => document.getElementById(id);
  const LS = "victory-vouchers-v1", LS_SHOTS = "victory-shots-v1", LS_MODE = "victory-codemode";
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch(e){ return d; } };
  let items = load(LS, []), shots = load(LS_SHOTS, []);
  let lastAdded = new Set();

  // The voucher shows its load date (תאריך הטענה); it is valid for 5 years from then.
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const todayIso = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`; };
  const plusYears = (iso, n) => { const [y,m,d] = iso.split("-"); return `${+y + n}-${m}-${d}`; };
  const expiryOf = v => v.loaded ? plusYears(v.loaded, 5) : (v.expiry || null);
  // earlier versions saved the date they found as an expiry date; a date in the past is really the load date
  // Anything read from storage or from a backup file is rebuilt field by field,
  // so a damaged or tampered file can only ever produce plain, well-formed vouchers.
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  function cleanItem(v){
    if(!v || typeof v !== "object" || !/^\d{13}$/.test(String(v.code || ""))) return null;
    const num = x => (typeof x === "number" && isFinite(x) && x >= 0 && x <= 100000) ? Math.round(x * 100) / 100 : null;
    const ts = x => (typeof x === "number" && isFinite(x) && x > 0) ? x : undefined;
    const iso = x => (typeof x === "string" && ISO.test(x)) ? x : null;
    const o = { id: /^[a-z0-9]{1,40}$/i.test(String(v.id || "")) ? String(v.id) : uid(), code: String(v.code) };
    if("amount" in v && !("balance" in v)) o.amount = num(v.amount);
    else { o.balance = num(v.balance); o.loadAmount = num(v.loadAmount); }
    o.loaded = iso(v.loaded); if(iso(v.expiry)) o.expiry = v.expiry;
    o.shot = /^[0-9a-f]{64}$/.test(String(v.shot || "")) ? v.shot : null;
    o.used = v.used === true; o.added = ts(v.added) || Date.now();
    if(v.deleted === true) o.deleted = true;
    for(const k of ["usedAt", "deletedAt", "exportedAt", "balanceSetAt"]) if(ts(v[k])) o[k] = v[k];
    if(["CODE128", "CODE39", "QR", "EAN13"].includes(v.exportFmt)) o.exportFmt = v.exportFmt;
    return o;
  }
  const cleanList = a => (Array.isArray(a) ? a : []).map(cleanItem).filter(Boolean);
  const cleanShots = a => (Array.isArray(a) ? a : []).filter(h => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)).slice(-500);
  items = cleanList(items); shots = cleanShots(shots);

  function migrate(v){
    if(!v.loaded && v.expiry && v.expiry <= todayIso()){ v.loaded = v.expiry; delete v.expiry; }
    // one "amount" field became two: what was loaded, and what is left
    if(v.balance === undefined && "amount" in v){ v.balance = v.amount ?? null; v.loadAmount = v.amount ?? null; delete v.amount; }
    // an earlier version sometimes read a stray "1" as an amount; clear it unless the user set it
    if(v.loadAmount === 1) v.loadAmount = null;
    if(v.balance === 1 && !v.balanceSetAt) v.balance = null;
    return v;
  }
  items.forEach(migrate);
  const balOf = v => v.balance ?? v.loadAmount ?? null;

  const group = c => [c.slice(0,3), c.slice(3,6), c.slice(6,9), c.slice(9)];
  const money = n => "₪" + (Math.round(n*100)/100).toLocaleString("he-IL");
  const fmtDate = t => { const d = new Date(t); return d.getDate() + "/" + (d.getMonth()+1) + "/" + d.getFullYear(); };
  function ean13ok(c){ let s=0; for(let i=0;i<12;i++) s += (+c[i])*(i%2?3:1); return (10 - s%10)%10 === +c[12]; }
  function setStatus(t, err){ $("status").textContent = t || ""; $("status").classList.toggle("err", !!err); }
  const LS_BK = "victory-backup", LS_SNAPS = "victory-snaps";
  let bk = Object.assign({ lastAt: 0, changes: 0, snooze: 0 }, load(LS_BK, {}));
  let snaps = load(LS_SNAPS, []); if(!Array.isArray(snaps)) snaps = [];
  let lastSaved = JSON.stringify(items);
  function keepSnap(json){
    // one copy a day: the list as it was before that day's first change
    const day = todayIso();
    if(json === "[]" || snaps.some(x => x.day === day)) return;
    snaps.push({ day, at: Date.now(), items: json });
    snaps = snaps.slice(-7);
    try { localStorage.setItem(LS_SNAPS, JSON.stringify(snaps)); } catch(e){}
  }
  function save(){
    const now = JSON.stringify(items);
    if(now !== lastSaved){ keepSnap(lastSaved); bk.changes++; lastSaved = now; try { localStorage.setItem(LS_BK, JSON.stringify(bk)); } catch(e){} }
    try { localStorage.setItem(LS, now); localStorage.setItem(LS_SHOTS, JSON.stringify(shots)); } catch(e){}
    render();
  }

  if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  async function fileHash(f){
    try{ const h = await crypto.subtle.digest("SHA-256", await f.arrayBuffer());
      return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,"0")).join(""); }catch(e){ return null; }
  }
  function shotKnown(h){
    if(!shots.includes(h)) return false;
    const linked = items.filter(v => v.shot === h);
    // screenshots from older versions have no link to their vouchers, so they stay known until a reset
    return !linked.length || linked.some(v => !v.deleted);
  }
  function forgetShotIfUnused(h){ if(h && !items.some(v => v.shot === h)) shots = shots.filter(x => x !== h); }
  function rememberShot(h){ if(!h || shots.includes(h)) return; shots.push(h); if(shots.length > 500) shots = shots.slice(-500); }


  function addCodes(list){
    let added = 0, dup = 0, dupUsed = 0, dupTrash = 0, restored = 0, updated = 0; const addedItems = []; lastAdded = new Set();
    for(const v of list){
      const code = String(v.code || "").replace(/\D/g, "");
      if(code.length !== 13) continue;
      const ex = items.find(x => x.code === code);
      const pos = x => (typeof x === "number" && x > 0) ? Math.round(x*100)/100 : null;
      const balance = pos(v.balance) ?? pos(v.loadAmount), loadAmount = pos(v.loadAmount) ?? pos(v.balance);
      const loaded = (typeof v.loaded === "string" && ISO.test(v.loaded)) ? v.loaded : null;
      if(ex){
        if(ex.deleted){
          // read again after deleting: bring it back from the trash with the new details
          ex.deleted = false; delete ex.deletedAt; ex.used = false; delete ex.usedAt;
          if(balance != null) ex.balance = balance; if(loadAmount != null) ex.loadAmount = loadAmount; if(loaded){ ex.loaded = loaded; delete ex.expiry; } if(v.shot) ex.shot = v.shot;
          restored++; lastAdded.add(code); continue;
        }
        let changed = false;
        if(ex.loadAmount == null && loadAmount != null){ ex.loadAmount = loadAmount; changed = true; }
        // a newer screenshot shows a lower balance after a partial use; balances only go down
        if(balance != null && (ex.balance == null || balance < ex.balance)){ ex.balance = balance; changed = true; }
        if(!ex.loaded && loaded){ ex.loaded = loaded; delete ex.expiry; changed = true; }
        if(v.shot && !ex.shot) ex.shot = v.shot;
        if(changed) updated++;
        if(ex.used) dupUsed++; else { dup++; lastAdded.add(code); }
        continue;
      }
      const item = { id: uid(), code, balance, loadAmount, loaded, shot: v.shot || null, used: false, added: Date.now() };
      items.unshift(item); addedItems.push(item);
      lastAdded.add(code); added++;
    }
    save();
    const first = document.querySelector(".item.new");
    if(first) first.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    return { added, dup, dupUsed, dupTrash, restored, updated, addedItems };
  }
  function resultText(r){
    const p = [];
    if(r.added) p.push(r.added === 1 ? "נוסף תו אחד." : `נוספו ${r.added} תווים.`);
    if(r.dup) p.push(r.dup === 1 ? "תו אחד כבר נמצא ברשימה (מסומן בצהוב), ולא נוסף שוב." : `${r.dup} תווים כבר נמצאים ברשימה (מסומנים בצהוב), ולא נוספו שוב.`);
    if(r.dupUsed) p.push(r.dupUsed === 1 ? "תו אחד כבר מומש בעבר, ולא נוסף." : `${r.dupUsed} תווים כבר מומשו בעבר, ולא נוספו.`);
    if(r.restored) p.push(r.restored === 1 ? "תו אחד שהיה בפח חזר לרשימה." : `${r.restored} תווים שהיו בפח חזרו לרשימה.`);
    if(r.updated) p.push(r.updated === 1 ? "תו אחד עודכן (יתרה, סכום או תאריך)." : `${r.updated} תווים עודכנו (יתרה, סכום או תאריך).`);
    return p.join(" ");
  }


  function daysLeft(iso){ if(!iso) return null; const [y,mo,d] = iso.split("-").map(Number); const t = new Date(); t.setHours(0,0,0,0); return Math.round((new Date(y, mo-1, d) - t) / 864e5); }
  const isoToHe = iso => iso.split("-").reverse().join("/");
  function expState(iso){
    const n = daysLeft(iso); if(n === null || n > 30) return null;
    const e = document.createElement("span"); e.className = "exp " + (n < 0 ? "gone" : "soon");
    e.textContent = n < 0 ? "פג תוקף" : n === 0 ? "פג היום" : n === 1 ? "פג מחר" : `פג בעוד ${n} ימים`;
    return e;
  }

  // ---------- reading digits from a screenshot (on the phone) ----------
  let worker = null;
  async function getWorker(){
    if(worker) return worker;
    if(!window.Tesseract) throw new Error("no-ocr");
    // the reader, its engine and its language data are all files of this site
    const here = new URL(".", location.href).href;
    worker = await Tesseract.createWorker("eng", 1, {
      workerPath: here + "lib-tesseract-worker.min.js", corePath: here.replace(/\/$/, ""), langPath: here.replace(/\/$/, ""),
      workerBlobURL: false, gzip: true,
      logger: m => { if(m.status === "recognizing text") setStatus("קורא את הספרות… " + Math.round(m.progress*100) + "%"); }
    });
    await worker.setParameters({ tessedit_pageseg_mode: "11" });
    return worker;
  }
  async function prepare(file){
    const bmp = await createImageBitmap(file);
    const target = 2200, k = Math.min(3, target / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width*k); c.height = Math.round(bmp.height*k);
    const ctx = c.getContext("2d");
    ctx.filter = "grayscale(1) contrast(1.4)";
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }
  // Find 13-digit codes, amounts and dates in the recognised text.
  // The English model reads digits reliably; Hebrew words come out garbled,
  // so currency signs are matched in the forms they usually take (₪ as "RI", "M" or "w", ש"ח as n"v).
  // Real currency signs may stand apart from the number. Single letters that the
  // reader sometimes makes of ₪ ("M", "w", "RI") only count when glued to the number,
  // because garbled Hebrew is full of such letters next to stray digits.
  const CUR_REAL = '(?:₪|NIS|ILS|ש["״׳\']?ח|n["”״\'][vwyY])';
  const CUR_LETTER = '(?:R[Il1|]\\s?|M|[wW])';
  const NUM = '(\\d{1,4}(?:[.,]\\d{1,2})?)';
  const AMT_REAL1 = new RegExp(CUR_REAL + '\\s*' + NUM + '(?![\\d/])', 'g');
  const AMT_REAL2 = new RegExp('(?<![\\d.,/])' + NUM + '\\s*' + CUR_REAL, 'g');
  const AMT_LETTER = new RegExp('(?<![A-Za-z0-9])' + CUR_LETTER + NUM + '(?![\\d/A-Za-z])', 'g');
  const DATE = /(?<!\d)(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})(?!\d)/g;
  const DATE_YMD = /(?<!\d)(20\d{2})[\/.\-](\d{1,2})[\/.\-](\d{1,2})(?!\d)/g;   // 2026-10-25, as Multipass shows it

  function extract(text){
    const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const codes = [], amounts = [], dates = [];
    lines.forEach((raw, li) => {
      let m;
      const pushDate = (y, mo, d) => {
        if(y < 100) y += 2000;
        if(d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2015 && y <= 2045)
          dates.push({ li, iso: `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}` });
      };
      DATE_YMD.lastIndex = 0;
      while((m = DATE_YMD.exec(raw))) pushDate(+m[1], +m[2], +m[3]);
      const noYmd = raw.replace(DATE_YMD, " ");
      DATE.lastIndex = 0;
      while((m = DATE.exec(noYmd))) pushDate(+m[3], +m[2], +m[1]);
      const noDates = noYmd.replace(DATE, " ");
      // codes
      if((noDates.match(/\d/g) || []).length >= 10){
        const line = noDates.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1");
        line.split(/[^\d\s\-–]+/).forEach(chunk => {
          const g = chunk.match(/\d+/g) || [];
          let hit = false;
          for(let i = 0; i < g.length; i++){
            let s = "";
            for(let j = i; j < g.length && s.length < 13; j++){ s += g[j]; if(s.length === 13){ codes.push({ li, code: s, ok: true }); hit = true; } }
          }
          if(!hit){ const all = g.join(""); if(all.length >= 11 && all.length <= 15) codes.push({ li, code: all, ok: false }); }
        });
      }
      // amounts (ignore long digit runs, which belong to codes)
      const amtLine = noDates.replace(/\d[\d\s\-–]{9,}\d/g, " ").replace(/(?<!\d)\d{1,2}:\d{2}(?!\d)/g, " ");
      const seen = new Set();
      // alt: the reader sometimes turns ₪ into a leading "5" ("550" instead of "₪50")
      const addAmt = (raw, kind) => {
        const val = parseFloat(raw.replace(",", "."));
        if(!(val >= (kind === "real" ? 1 : 5) && val <= 10000) || seen.has(val)) return;
        seen.add(val);
        const digits = raw.split(/[.,]/)[0];
        const alt = (kind !== "real" && digits.length >= 3 && digits[0] === "5") ? parseFloat(raw.slice(1).replace(",", ".")) : null;
        amounts.push({ li, val, alt: alt >= 5 ? alt : null, kind });
      };
      for(const [re, kind] of [[AMT_REAL1, "real"], [AMT_REAL2, "real"], [AMT_LETTER, "letter"]]){
        re.lastIndex = 0;
        while((m = re.exec(amtLine))) addAmt(m[1], kind);
      }
      // "סכום הטענה: ₪50" comes out as "50 :garble", with the number first
      const colon = amtLine.match(/^\W{0,2}[A-Za-z]{0,2}(\d{1,4}(?:[.,]\d{1,2})?)\s*:/);
      if(colon) addAmt(colon[1], "colon");
      // the big balance on the card stands alone on its line, maybe with a stray letter or two for ₪
      const lone = amtLine.trim().match(/^(?:[A-Za-z]{1,2}\s?)?(\d{2,4}(?:[.,]\d{1,2})?)(?:\s?[A-Za-z]{1,2})?$/);
      if(lone) addAmt(lone[1], "lone");
    });

    const byCode = new Map();
    codes.forEach(c => { if(!byCode.has(c.code)) byCode.set(c.code, c); });
    const list = [...byCode.values()].filter(c => c.ok || ![...byCode.values()].some(f => f.ok && (f.code.includes(c.code) || c.code.includes(f.code))));
    const single = list.filter(c => c.ok).length <= 1;
    const nearest = (arr, li, rank) => {
      let best = null, bs = Infinity;
      arr.forEach(x => { const d = Math.abs(x.li - li); if(d > 6) return; const sc = rank(x) * 100 + d + (x.li < li ? 0.5 : 0); if(sc < bs){ bs = sc; best = x; } });
      return best;
    };
    const today = todayIso();
    const out = list.map(c => {
      let balance = null, loadAmount = null, loaded = null;
      if(single){
        // one voucher: the clearest amount, and the load date, which is the earliest date (and not in the future)
        const all = dates.map(d => d.iso).sort();
        const past = all.filter(d => d <= today);
        loaded = past.length ? past[0] : (all[0] || null);
        // balance = the amount closest to the code; load amount = the amount closest to the load date
        const strong = amounts;
        const b = strong.slice().sort((x, y) => Math.abs(x.li - c.li) - Math.abs(y.li - c.li))[0];
        balance = b ? b.val : null;
        const dLine = (dates.find(d => d.iso === loaded) || {}).li;
        const rest = strong.filter(a => a !== b);
        const l = rest.length ? (dLine != null ? rest.sort((x, y) => Math.abs(x.li - dLine) - Math.abs(y.li - dLine))[0] : rest[0]) : null;
        loadAmount = l ? l.val : balance;
        // undo a "₪" read as a leading 5 when the other amount on the voucher confirms it
        if(b && b.alt != null && (loadAmount === b.alt || (l && l.alt === b.alt) || (loadAmount != null && balance > loadAmount && b.alt <= loadAmount))) balance = b.alt;
        if(l && l.alt != null && (balance === l.alt || (b && b.alt === l.alt))) loadAmount = l.alt;
        if(b && !l && b.alt != null && b.val > 1000) { balance = loadAmount = b.alt; }
      } else {
        const a = nearest(amounts, c.li, x => x.kind === "real" || x.kind === "letter" ? 0 : 1); balance = loadAmount = a ? a.val : null;
        const d = nearest(dates, c.li, x => x.iso <= today ? 0 : 1); loaded = d ? d.iso : null;
      }
      return { code: c.code, ok: c.ok, li: c.li, balance, loadAmount, loaded };
    });
    return { found: out.filter(c => c.ok), near: out.filter(c => !c.ok) };
  }


  // How sure the reader was of each digit, and a cut-out of the number from the screenshot.
  const LOW_CONF = 92;
  function digitInfo(line, code){
    const arr = [];
    (line.words || []).forEach(w => (w.symbols || []).forEach(sy => {
      for(const ch of String(sy.text || "")){
        const d = /[Oo]/.test(ch) ? "0" : /[Il|]/.test(ch) ? "1" : ch;
        if(/\d/.test(d)) arr.push({ d, conf: d === ch ? sy.confidence : 0, box: sy.bbox });   // a letter read as a digit is never trusted
      }
    }));
    const at = arr.map(a => a.d).join("").indexOf(code);
    if(at < 0) return null;
    const part = arr.slice(at, at + code.length);
    const box = part.reduce((b, a) => a.box ? { x0: Math.min(b.x0, a.box.x0), y0: Math.min(b.y0, a.box.y0), x1: Math.max(b.x1, a.box.x1), y1: Math.max(b.y1, a.box.y1) } : b, { x0: 1e9, y0: 1e9, x1: 0, y1: 0 });
    return { conf: part.map(a => a.conf), box: box.x1 > box.x0 ? box : null };
  }
  function cropOf(canvas, b){
    if(!b) return null;
    try{
      const px = 28, py = 18;
      const x = Math.max(0, b.x0 - px), y = Math.max(0, b.y0 - py);
      const w = Math.min(canvas.width - x, b.x1 - b.x0 + 2 * px), h = Math.min(canvas.height - y, b.y1 - b.y0 + 2 * py);
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, w, h);
      return c.toDataURL("image/png");
    }catch(e){ return null; }
  }
  function analyse(data, canvas){
    const lines = (data.lines || []).filter(l => l.text && l.text.trim());
    const res = extract(lines.length ? lines.map(l => l.text.trim().replace(/\s*\n\s*/g, " ")).join("\n") : (data.text || ""));
    res.found.concat(res.near).forEach(c => {
      const L = lines[c.li]; if(!L) return;
      const info = digitInfo(L, c.code);
      c.conf = info ? info.conf : null;
      c.crop = cropOf(canvas, (info && info.box) || L.bbox);
    });
    return res;
  }

  // queue of screenshots to read; new ones can join while reading
  const run = { queue: [], total: 0, done: 0, busy: false, stopped: false, same: 0, hashes: new Set() };
  function updateBulk(){
    const show = run.busy && run.total > 1;
    $("bulk").hidden = !show;
    if(!show) return;
    $("bulkBar").style.width = Math.round(run.done / run.total * 100) + "%";
    $("bulkText").textContent = `קורא צילומים… ${run.done} מתוך ${run.total}`;
  }
  $("bulkStop").onclick = () => { run.stopped = true; $("bulkText").textContent = "עוצר אחרי הצילום הנוכחי…"; };

  async function handleFiles(files){
    for(const f of files){
      const h = await fileHash(f);
      if(h && (shotKnown(h) || run.hashes.has(h))){ run.same++; continue; }
      if(h) run.hashes.add(h);
      run.queue.push({ file: f, hash: h }); run.total++;
    }
    if(run.busy){ updateBulk(); return; }
    if(!run.queue.length){ setStatus(""); reportSame(); return; }
    run.busy = true; run.stopped = false; updateBulk();
    while(run.queue.length && !run.stopped){
      const job = run.queue.shift();
      if(run.total === 1) setStatus("מכין את הקריאה… בפעם הראשונה זה לוקח כמה שניות.");
      let res = { found: [], near: [] }, failed = false;
      try{
        const w = await getWorker();
        const canvas = await prepare(job.file);
        const { data } = await w.recognize(canvas);
        res = analyse(data, canvas);
      }catch(e){
        failed = true;
        if(e && e.message === "no-ocr"){ setStatus("רכיב הקריאה לא נטען. בדוק חיבור לאינטרנט ונסה שוב, או הקלד ידנית.", true); run.stopped = true; }
      }
      addReviewCard(job, res, failed);
      run.done++; updateBulk();
    }
    // screenshots left after a stop are dropped from this round, so they can be chosen again
    run.queue.splice(0).forEach(j => run.hashes.delete(j.hash));
    run.busy = false; updateBulk();
    if(run.total > 1 || !$("status").classList.contains("err")) setStatus(run.stopped ? "הקריאה נעצרה. מה שנקרא עד עכשיו מחכה לבדיקה." : "");
    run.total = 0; run.done = 0;
    reportSame();
  }
  function reportSame(){
    if(!run.same) return;
    const t = run.same === 1 ? "צילום מסך אחד כבר נקרא בעבר, ודילגתי עליו." : `${run.same} צילומי מסך כבר נקראו בעבר, ודילגתי עליהם.`;
    setStatus(($("status").textContent ? $("status").textContent + " " : "") + t);
    run.same = 0;
  }

  function addReviewCard(job, res, failed){
    const card = document.createElement("div"); card.className = "rv-card";
    card._hash = job.hash;
    const url = URL.createObjectURL(job.file); card._url = url;
    const img = document.createElement("button"); img.type = "button"; img.className = "shot-btn";
    img.setAttribute("aria-label", "פתיחת הצילום בגדול, לצד מה שנקרא");
    const pic = document.createElement("img"); pic.className = "shot"; pic.src = url; pic.alt = "";
    const hint = document.createElement("span"); hint.textContent = "הגדלה";
    img.append(pic, hint);
    img.onclick = () => openShot(card);
    const note = document.createElement("p"); note.className = "rv-note";
    note.textContent = failed ? "לא הצלחתי לקרוא את הצילום. אפשר להקליד את המספר כאן." :
      res.found.length ? "" : res.near.length ? "מצאתי מספר, אבל לא בדיוק 13 ספרות. תקן אותו לפי הצילום." : "לא מצאתי מספר של 13 ספרות. אפשר להקליד אותו כאן, או להסיר את הצילום.";
    const rows = document.createElement("div");
    const addRow = (obj, checked) => {
      obj = obj || {};
      const val = obj.code || "";
      const wrap = document.createElement("div"); wrap.className = "cand-wrap";
      if(obj.crop){ const im = document.createElement("img"); im.className = "crop"; im.src = obj.crop; im.alt = "המספר כפי שהוא מופיע בצילום"; wrap.append(im); }
      if(obj.conf && obj.conf.some(c => c < LOW_CONF)){
        const ro = document.createElement("p"); ro.className = "readout"; ro.setAttribute("aria-hidden", "true");
        [...val].forEach((d, i) => { const sp = document.createElement("span"); sp.textContent = d; if(obj.conf[i] < LOW_CONF) sp.className = "low"; if(i === 3 || i === 6 || i === 9) sp.classList.add("gap"); ro.append(sp); });
        const n = obj.conf.filter(c => c < LOW_CONF).length;
        const note = document.createElement("p"); note.className = "read-note warn";
        note.textContent = n === 1 ? "ספרה אחת נקראה בביטחון נמוך (מסומנת). בדקו אותה מול הצילום." : `${n} ספרות נקראו בביטחון נמוך (מסומנות). בדקו אותן מול הצילום.`;
        wrap.append(ro, note);
      } else if(obj.conf){
        const note = document.createElement("p"); note.className = "read-note"; note.textContent = "כל הספרות נקראו בביטחון גבוה.";
        wrap.append(note);
      }
      const row = document.createElement("div"); row.className = "cand";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = checked; cb.setAttribute("aria-label", "להוסיף את המספר הזה");
      const inp = document.createElement("input"); inp.className = "num"; inp.inputMode = "numeric"; inp.value = val; inp.placeholder = "13 ספרות"; inp.setAttribute("aria-label", "מספר התו");
      const fl = document.createElement("span"); fl.className = "flag";
      const upd = () => { const n = inp.value.replace(/\D/g, "").length; fl.textContent = (n === 13 || n === 0) ? "" : n + " ספרות"; if(n === 13) cb.checked = true; };
      inp.oninput = upd; upd();
      row.append(cb, inp, fl);
      const ex = document.createElement("div"); ex.className = "cand-extra";
      const la = document.createElement("label"); la.textContent = "יתרה ₪";
      const amt = document.createElement("input"); amt.className = "amt"; amt.inputMode = "decimal"; amt.value = obj.balance ?? ""; amt.placeholder = "לא נמצא";
      la.appendChild(amt);
      const lb = document.createElement("label"); lb.textContent = "הוטען ₪";
      const amt2 = document.createElement("input"); amt2.className = "amt amt2"; amt2.inputMode = "decimal"; amt2.value = obj.loadAmount ?? ""; amt2.placeholder = "לא נמצא";
      lb.appendChild(amt2);
      const ld = document.createElement("label"); ld.textContent = "תאריך הטענה";
      const dt = document.createElement("input"); dt.type = "date"; dt.className = "exp-in"; dt.value = obj.loaded || "";
      ld.appendChild(dt);
      const until = document.createElement("span");
      const showUntil = () => { until.textContent = dt.value ? "בתוקף עד " + isoToHe(plusYears(dt.value, 5)) : ""; };
      dt.onchange = showUntil; showUntil();
      ex.append(la, lb, ld, until);
      wrap.append(row, ex); rows.appendChild(wrap);
      return inp;
    };
    res.found.forEach(n => addRow(n, true));
    res.near.forEach(n => addRow(n, false));
    if(!res.found.length && !res.near.length) addRow(null, false);
    const acts = document.createElement("div"); acts.className = "rv-actions";
    acts.append(mkBtn("עוד מספר", "", () => addRow(null, false).focus()), mkBtn("הסרת הצילום", "del", () => dropCard(card, true)));
    card.append(img); if(note.textContent) card.append(note); card.append(rows, acts);
    $("rvList").appendChild(card);
    updateReview();
    if($("rvList").children.length === 1) $("review").scrollIntoView({ block: "start" });
  }
  // The screenshot in full, with what was read from it pinned underneath, so nothing has to be scrolled away to compare.
  function openShot(card){
    const box = $("shotViewBox"), read = $("shotViewRead");
    $("shotViewImg").src = card._url; box.classList.remove("zoom"); box.scrollTop = 0; box.scrollLeft = 0;
    read.innerHTML = "";
    const rows = [...card.querySelectorAll(".cand-wrap")].filter(r => r.querySelector(".num").value.trim());
    if(!rows.length) read.append(el("p", "read-note", "לא נקרא מספר מהצילום הזה. אפשר להקליד אותו בכרטיס."));
    rows.forEach(r => {
      const code = r.querySelector(".num").value.replace(/\D/g, "");
      const item = el("div", "vr-item");
      const c = el("div", "vr-code" + (code.length === 13 ? "" : " bad"));
      (code.length === 13 ? group(code) : [code]).forEach(g => c.append(el("span", null, g)));
      const meta = el("div", "vr-meta");
      const pair = (label, val) => { const w = el("span", null, label + " "); w.append(el("b", null, val)); meta.append(w); };
      if(code.length !== 13) pair("אורך", code.length + " ספרות במקום 13");
      const bal = r.querySelector(".amt").value.trim(), ld = r.querySelector(".amt2").value.trim(), dt = r.querySelector(".exp-in").value;
      pair("יתרה", bal ? "₪" + bal : "לא נקראה");
      pair("הוטען", ld ? "₪" + ld : "לא נקרא");
      pair("תאריך הטענה", dt ? isoToHe(dt) : "לא נקרא");
      item.append(c, meta); read.append(item);
    });
    showDialog($("shotView"));
  }
  $("shotViewBox").addEventListener("click", e => {
    const box = $("shotViewBox"), img = $("shotViewImg");
    const r = img.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    const zoomed = box.classList.toggle("zoom");
    // keep the tapped spot in view after the size changes
    requestAnimationFrame(() => {
      const n = img.getBoundingClientRect();
      box.scrollLeft = zoomed ? Math.max(0, fx * n.width - box.clientWidth / 2) : 0;
      box.scrollTop = Math.max(0, fy * n.height - box.clientHeight / 2);
    });
  });
  $("shotView").addEventListener("click", e => { if(e.target.closest("[data-close]")) $("shotView").close(); });

  function dropCard(card, forget){
    URL.revokeObjectURL(card._url);
    if(forget) run.hashes.delete(card._hash);
    card.remove(); updateReview();
  }
  function updateReview(){
    const n = $("rvList").children.length;
    $("review").hidden = !n;
    $("rvTitle").textContent = n === 1 ? "בדוק את המספר שנמצא" : `בדוק את המספרים שנמצאו (${n} צילומים)`;
  }
  $("rvClear").onclick = async () => {
    const n = $("rvList").children.length;
    if(!await ask({ title: n === 1 ? "לבטל את הצילום שממתין לבדיקה?" : `לבטל ${n} צילומים שממתינים לבדיקה?`, text: "התווים שבהם לא יתווספו לרשימה.", ok: "ביטול הצילומים", danger: true })) return;
    [...$("rvList").children].forEach(c => dropCard(c, true)); setStatus("");
  };
  $("rvAddAll").onclick = () => {
    const cards = [...$("rvList").children];
    const toAdd = []; let bad = 0, empty = 0;
    cards.forEach(card => {
      const codes = [...card.querySelectorAll(".cand-wrap")].filter(r => r.querySelector("input[type=checkbox]").checked)
        .map(r => {
          const num = el => { const n = parseFloat(el.value.replace(",", ".")); return isNaN(n) ? null : n; };
          return { code: r.querySelector(".num").value.replace(/\D/g, ""), balance: num(r.querySelector(".amt")), loadAmount: num(r.querySelector(".amt2")), loaded: r.querySelector(".exp-in").value || null, shot: card._hash || null };
        });
      if(!codes.length){ empty++; return; }
      if(codes.some(c => c.code.length !== 13)){ bad++; card.classList.add("bad"); return; }
      card.classList.remove("bad");
      codes.forEach(c => toAdd.push(c));
      rememberShot(card._hash);
      dropCard(card, true);
    });
    const p = [];
    let r = null;
    if(toAdd.length) r = addCodes(toAdd);
    if(bad) p.push(bad === 1 ? "בצילום אחד יש מספר מסומן שאין בו 13 ספרות (מסומן באדום)." : `ב-${bad} צילומים יש מספר מסומן שאין בו 13 ספרות (מסומנים באדום).`);
    if(empty) p.push(empty === 1 ? "צילום אחד נשאר בלי מספר מסומן. סמן מספר או הסר אותו." : `${empty} צילומים נשארו בלי מספר מסומן. סמן מספר או הסר אותם.`);
    setStatus(p.join(" "), !!p.length);
    if(r) showAdded(r);
  };

  $("file").onchange = (ev) => { const files = Array.from(ev.target.files || []); ev.target.value = ""; if(files.length) handleFiles(files); };

  // Screenshots shared from the Android share sheet arrive here through the service worker
  async function checkInbox(){
    if(!("caches" in window)) return;
    try{
      const inbox = await caches.open("share-inbox");
      const keys = await inbox.keys();
      const files = [];
      for(const k of keys){
        const res = await inbox.match(k);
        if(res){ const b = await res.blob(); files.push(new File([b], "shared", { type: b.type || "image/png" })); }
        await inbox.delete(k);
      }
      if(files.length) handleFiles(files);
    }catch(e){}
    if(location.search) history.replaceState(null, "", location.pathname);
  }
  checkInbox();
  document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible") checkInbox(); });


  // ---------- small helpers for the interface ----------
  const codeTxt = v => "\u2066" + group(v.code).join(" ") + "\u2069";   // keeps the digit groups in order inside Hebrew text
  const vName = v => balOf(v) != null ? "על סך " + money(balOf(v)) : "שמספרו " + codeTxt(v);
  const parseMoney = s => { const n = parseFloat(String(s).replace(",", ".").replace(/[^\d.]/g, "")); return isNaN(n) ? null : Math.round(n*100)/100; };
  function el(tag, cls, text){ const e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }
  function mkBtn(text, cls, fn){ const b = el("button", "btn small " + (cls || ""), text); b.type = "button"; b.onclick = fn; return b; }
  function iconBtn(icon, label, fn){ const b = el("button", "icon-btn"); b.type = "button"; b.setAttribute("aria-label", label); b.innerHTML = `<svg><use href="#${icon}"/></svg>`; b.onclick = fn; return b; }
  function moneyHtml(n){ const f = el("span"); f.append(el("span", "cur", "₪"), document.createTextNode((Math.round(n*100)/100).toLocaleString("he-IL"))); return f; }

  // ---------- dialogs ----------
  const dlg = $("dlg");
  function ask({ title, text = "", ok = "אישור", cancel = "ביטול", danger = false, kind = "", icon = "?" }){
    return new Promise(resolve => {
      $("dlgIcon").textContent = icon;
      $("dlgTitle").textContent = title;
      $("dlgText").textContent = text; $("dlgText").hidden = !text;
      $("dlgOk").textContent = ok; $("dlgOk").className = "btn " + (danger ? "danger" : "primary");
      $("dlgCancel").className = "btn " + (danger ? "primary" : "quiet");
      $("dlgCancel").textContent = cancel || ""; $("dlgCancel").hidden = !cancel;
      dlg.dataset.kind = danger ? "danger" : kind;
      let settled = false;
      const done = v => { if(settled) return; settled = true; dlg.close(); resolve(v); };
      $("dlgOk").onclick = () => done(true);
      $("dlgCancel").onclick = () => done(false);
      dlg.oncancel = e => { e.preventDefault(); done(false); };
      dlg.onclick = e => { if(e.target === dlg) done(false); };
      showDialog(dlg);
      (cancel ? $("dlgCancel") : $("dlgOk")).focus();
    });
  }
  const tell = o => ask(Object.assign({ cancel: null, ok: "סגירה", kind: "ok", icon: "✓" }, o));

  // Android back button: while any window or the till screen is open, one history
  // entry is kept; pressing back closes the top window instead of leaving the app.
  let armed = !!(history.state && history.state.tavim), pendingBack = false;
  const anyOpen = () => selecting || $("reader").classList.contains("open") || !!document.querySelector("dialog[open]");
  function arm(){ if(pendingBack || armed) return; history.pushState({ tavim: 1 }, ""); armed = true; }
  function maybeDisarm(){
    setTimeout(() => { if(!anyOpen() && armed && !pendingBack){ armed = false; pendingBack = true; history.back(); } }, 0);
  }
  function closeTop(){
    const open = [...document.querySelectorAll("dialog[open]")];
    const top = open.sort((a, b) => (b._openedAt || 0) - (a._openedAt || 0))[0];
    if(top){ if(top === dlg) ($("dlgCancel").hidden ? $("dlgOk") : $("dlgCancel")).click(); else top.close(); return; }
    if($("reader").classList.contains("open")){ closeReader(); return; }
    if(selecting) exitSelect();
  }
  window.addEventListener("popstate", () => {
    if(pendingBack){ pendingBack = false; if(anyOpen()) arm(); return; }
    armed = false;
    closeTop();
    if(anyOpen()) arm();
  });
  function showDialog(d){ d._openedAt = performance.now(); d.showModal(); arm(); }
  document.querySelectorAll("dialog").forEach(d => d.addEventListener("close", maybeDisarm));
  if(armed) maybeDisarm();

  function openSheet(d){ showDialog(d); }

  // swipe a sheet down by its handle or title to close it
  document.querySelectorAll("dialog.sheet").forEach(d => {
    const body = d.querySelector(".sheet-body");
    let y0 = null, dy = 0, t0 = 0, pid = null;
    body.addEventListener("pointerdown", e => {
      if(e.button > 0 || !e.target.closest(".grab-zone, h2, .sub")) return;
      y0 = e.clientY; dy = 0; t0 = performance.now(); pid = e.pointerId;
      body.setPointerCapture(pid); body.style.transition = "none";
    });
    body.addEventListener("pointermove", e => {
      if(y0 === null || e.pointerId !== pid) return;
      dy = Math.max(0, e.clientY - y0); body.style.transform = dy ? `translateY(${dy}px)` : "";
    });
    const end = () => {
      if(y0 === null) return;
      const speed = dy / Math.max(1, performance.now() - t0);
      y0 = null; body.style.transition = "transform .2s ease-out";
      if(dy > body.offsetHeight * 0.25 || (dy > 40 && speed > 0.5)){
        body.style.transform = "translateY(100%)";
        setTimeout(() => { d.close(); body.style.transition = "none"; body.style.transform = ""; }, 190);
      } else body.style.transform = "";
    };
    body.addEventListener("pointerup", end);
    body.addEventListener("pointercancel", end);
  });

  // appearance
  const THEME_KEY = "victory-theme";
  function applyTheme(t){
    const root = document.documentElement;
    if(t === "light" || t === "dark") root.setAttribute("data-theme", t); else root.removeAttribute("data-theme");
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
      if(!m.dataset.orig) m.dataset.orig = m.content;
      m.content = t === "light" ? "#f5f5f4" : t === "dark" ? "#161615" : m.dataset.orig;
    });
    document.querySelectorAll("#themeSeg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.themeOpt === (t || "auto"))));
  }
  document.querySelectorAll("#themeSeg button").forEach(b => b.onclick = () => {
    const t = b.dataset.themeOpt === "auto" ? null : b.dataset.themeOpt;
    try { if(t) localStorage.setItem(THEME_KEY, t); else localStorage.removeItem(THEME_KEY); } catch(e){}
    applyTheme(t);
  });
  applyTheme(localStorage.getItem(THEME_KEY));
  document.querySelectorAll("dialog.sheet").forEach(d => {
    d.addEventListener("click", e => { if(e.target === d || e.target.closest("[data-close]")) d.close(); });
  });

  // ---------- add ----------
  function showAdded(r){
    const others = resultText(Object.assign({}, r, { added: 0 }));
    if(r.added){ tab = "active"; render(); }
    if(r.added === 1){
      const it = r.addedItems[0];
      return tell({ title: "התו נוסף בהצלחה", text: [balOf(it) != null ? `התו על סך ${money(balOf(it))} נוסף לרשימה.` : "התו נוסף לרשימה.", others].filter(Boolean).join(" ") });
    }
    if(r.added > 1){
      const total = r.addedItems.reduce((s, v) => s + (balOf(v) || 0), 0);
      return tell({ title: `נוספו ${r.added} תווים בהצלחה`, text: [total ? `בסך כולל של ${money(total)}.` : "", others].filter(Boolean).join(" ") });
    }
    if(r.restored || r.updated) return tell({ title: "הרשימה עודכנה", text: others });
    return tell({ title: "לא נוסף תו חדש", text: others, kind: "", icon: "!" });
  }

  $("addBtn").onclick = () => openAdd();
  function openAdd(){
    $("addChoose").hidden = false; $("addForm").hidden = true; $("mErr").textContent = "";
    $("mCode").value = ""; $("mAmt").value = ""; $("mExp").value = "";
    openSheet($("addSheet"));
  }
  $("addManual").onclick = () => { $("addChoose").hidden = true; $("addForm").hidden = false; $("mCode").focus(); };
  $("mAdd").onclick = () => {
    const code = $("mCode").value.replace(/\D/g, "");
    if(code.length !== 13){ $("mErr").textContent = `מספר התו צריך להכיל 13 ספרות. כרגע יש ${code.length}.`; $("mCode").focus(); return; }
    const r = addCodes([{ code, balance: parseMoney($("mAmt").value), loaded: $("mExp").value || null }]);
    $("addSheet").close();
    showAdded(r);
  };
  $("file").onchange = (ev) => {
    const files = Array.from(ev.target.files || []); ev.target.value = "";
    $("addSheet").close();
    if(files.length) handleFiles(files);
  };

  // ---------- list ----------
  let tab = "active";
  function active(){ return items.filter(v => !v.used && !v.deleted).sort((a,b) => (expiryOf(a)||"9999").localeCompare(expiryOf(b)||"9999") || b.added - a.added); }
  document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => { tab = b.dataset.tab; lastAdded = new Set(); render(); });

  function row(v, kind){
    const live = kind === "active" || kind === "pdf";
    const li = el("li", "item row" + (live ? "" : " done") + (lastAdded.has(v.code) ? " new" : "") + (selecting && selected.has(v.id) ? " sel" : ""));
    const main = el("button", "row-main"); main.type = "button";
    if(selecting){
      const box = el("span", "check"); box.innerHTML = '<svg aria-hidden="true"><use href="#i-tick"/></svg>'; li.append(box);
      main.setAttribute("role", "checkbox"); main.setAttribute("aria-checked", String(selected.has(v.id)));
      main.setAttribute("aria-label", `בחירת התו ${v.code}`);
      li.dataset.id = v.id;
    } else if(live){ main.onclick = () => openReader(v.id); main.setAttribute("aria-label", `הצגה בקופה, התו ${v.code}`); }
    else main.disabled = true;
    const code = el("span", "row-code"); group(v.code).forEach(g => code.append(el("span", null, g)));
    const amt = el("span", "row-amt");
    const bal = live ? balOf(v) : (v.loadAmount ?? v.balance);
    if(bal != null){
      amt.append(el("b", null, money(bal)));
      if(live && v.loadAmount != null && v.loadAmount !== bal) amt.append(el("small", null, "מתוך " + money(v.loadAmount)));
    } else amt.append(el("span", "none", "ללא יתרה"));
    const meta = el("span", "row-meta");
    if(kind === "pdf" && v.exportedAt) meta.append(el("span", "row-tag", "יוצא ב-" + fmtDate(v.exportedAt)));
    if(live){
      if(kind === "active" && v.exportedAt) meta.append(el("span", "row-tag", "יוצא"));
      if(v.loaded) meta.append(el("span", null, "הוטען ב-" + isoToHe(v.loaded)));
      const n = daysLeft(expiryOf(v));
      if(n !== null && n <= 30) meta.append(el("span", "alert-txt", n < 0 ? "פג תוקף" : n === 0 ? "פג היום" : n === 1 ? "פג מחר" : `פג בעוד ${n} ימים`));
    }
    if(kind === "used" && v.usedAt) meta.append(el("span", null, "מומש ב-" + fmtDate(v.usedAt)));
    if(kind === "trash" && v.deletedAt) meta.append(el("span", null, "נמחק ב-" + fmtDate(v.deletedAt)));
    main.append(code, amt);
    if(meta.childNodes.length) main.append(meta);
    li.append(main);
    if(!selecting) li.append(iconBtn("i-more", "פעולות לתו " + v.code, () => openMore(v, kind)));
    if(kind === "pdf" && !selecting){
      const acts = el("div", "row-acts");
      acts.append(mkBtn("השתמשתי", "primary", () => doUsed(v)), mkBtn("לא השתמשתי", "quiet", () => doUnexport(v)));
      li.append(acts);
    }
    return li;
  }
  function emptyState(){
    const li = el("li", "empty");
    if(tab === "active"){
      li.append(el("b", null, "עוד אין תווים"), el("p", null, "שתפו צילום מסך של תו מאפליקציית מולטיפס, או הוסיפו אותו כאן."));
      li.append(mkBtn("הוספת תווים", "quiet", openAdd));
    } else if(tab === "pdf") li.append(el("b", null, "אין תווים שיוצאו"), el("p", null, "תווים שמייצאים לקובץ PDF מופיעים כאן, כדי שאפשר יהיה לסמן אחר כך אם השתמשתם בהם."));
    else if(tab === "used") li.append(el("b", null, "אין תווים שמומשו"), el("p", null, "תו שמסמנים כמומש עובר לכאן."));
    else li.append(el("b", null, "הפח ריק"), el("p", null, "תו שמוחקים עובר לכאן, ואפשר לשחזר אותו."));
    return li;
  }
  function render(){
    const act = active();
    const used = items.filter(v => v.used && !v.deleted).sort((a,b) => (b.usedAt||0) - (a.usedAt||0));
    const trash = items.filter(v => v.deleted).sort((a,b) => (b.deletedAt||0) - (a.deletedAt||0));
    const total = act.reduce((s,v) => s + (balOf(v)||0), 0);
    const sa = $("sumAmt"); sa.innerHTML = ""; sa.append(moneyHtml(total));
    $("sumSub").textContent = act.length ? (act.length === 1 ? "בתו פעיל אחד" : `ב-${act.length} תווים פעילים`) : "אין תווים פעילים";
    const soon = act.filter(v => { const n = daysLeft(expiryOf(v)); return n !== null && n <= 30; }).length;
    $("sumWarn").hidden = !soon;
    $("sumWarn").textContent = soon === 1 ? "תו אחד פג בחודש הקרוב" : `${soon} תווים פגים בחודש הקרוב`;
    const inPdf = act.filter(v => v.exportedAt).sort((a,b) => (b.exportedAt||0) - (a.exportedAt||0));
    $("nActive").textContent = act.length || ""; $("nPdf").textContent = inPdf.length || ""; $("nUsed").textContent = used.length || ""; $("nTrash").textContent = trash.length || "";
    if(selecting && tab !== "active") tab = "active";
    document.querySelector(".tabs").hidden = selecting;
    $("selHead").hidden = !selecting; $("selBtns").hidden = !selecting; $("addBtn").hidden = selecting;
    if(selecting){
      [...selected].forEach(id => { if(!act.some(v => v.id === id)) selected.delete(id); });
      updateSelUi();
    }
    $("pdfBar").hidden = tab !== "pdf" || !inPdf.length || selecting;
    if(tab === "pdf"){ const t = inPdf.reduce((s, v) => s + (balOf(v) || 0), 0); $("pdfBarTxt").textContent = `${inPdf.length === 1 ? "תו אחד" : inPdf.length + " תווים"}${t ? ", בסך " + money(t) : ""}`; }
    document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    const list = $("list"); list.innerHTML = "";
    const rows = tab === "active" ? act : tab === "pdf" ? inPdf : tab === "used" ? used : trash;
    if(!rows.length) list.append(emptyState());
    rows.forEach(v => list.append(row(v, tab)));
    backupUi();
    // newly added or changed vouchers are tinted briefly, then settle
    if(list.querySelector(".row.new")) setTimeout(() => list.querySelectorAll(".row.new").forEach(r => r.classList.remove("new")), 1400);
  }

  // ---------- actions, each one confirmed ----------
  let undoSnap = null, toastT = 0;
  function toast(msg, snap, ms){
    undoSnap = snap; $("toastMsg").textContent = msg; $("toastUndo").hidden = !snap; $("toast").classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => $("toast").classList.remove("show"), ms || 5000);
  }
  $("toastUndo").onclick = () => { if(undoSnap){ items = undoSnap.items; shots = undoSnap.shots; undoSnap = null; lastAdded = new Set(); save(); if(curId) openReader(curId); } $("toast").classList.remove("show"); };
  const snapshot = () => JSON.parse(JSON.stringify({ items, shots }));

  async function doUsed(v){
    if(!await ask({ title: `לסמן את התו ${vName(v)} כמומש?`, text: `מספר ${codeTxt(v)}. התו יעבור לרשימת התווים שמומשו.`, ok: "סימון כמומש" })) return false;
    const s = snapshot(); v.used = true; v.usedAt = Date.now(); lastAdded = new Set(); save(); toast("התו סומן כמומש", s);
    return true;
  }
  async function doUnuse(v){
    if(!await ask({ title: `להחזיר את התו ${vName(v)} לפעילים?`, text: `מספר ${codeTxt(v)}.`, ok: "החזרה לפעילים" })) return;
    const s = snapshot(); v.used = false; delete v.usedAt; lastAdded = new Set([v.code]); save(); toast("התו חזר לפעילים", s);
  }
  async function doTrash(v){
    if(!await ask({ title: `למחוק את התו ${vName(v)}?`, text: `מספר ${codeTxt(v)}. התו יעבור לפח, ואפשר יהיה לשחזר אותו משם.`, ok: "מחיקה", danger: true, icon: "!" })) return;
    const s = snapshot(); v.deleted = true; v.deletedAt = Date.now(); lastAdded = new Set(); save(); toast("התו הועבר לפח", s);
  }
  async function doRestore(v){
    if(!await ask({ title: `לשחזר את התו ${vName(v)}?`, text: `מספר ${codeTxt(v)}. התו יחזור לרשימה${v.used ? " של התווים שמומשו" : " הפעילה"}.`, ok: "שחזור" })) return;
    const s = snapshot(); v.deleted = false; delete v.deletedAt; lastAdded = new Set([v.code]); save(); toast("התו שוחזר", s);
  }
  async function doPurge(v){
    if(!await ask({ title: `למחוק לצמיתות את התו ${vName(v)}?`, text: `מספר ${codeTxt(v)}. אחרי המחיקה אי אפשר יהיה לשחזר אותו.`, ok: "מחיקה לצמיתות", danger: true, icon: "!" })) return;
    const s = snapshot(); items = items.filter(x => x.id !== v.id); forgetShotIfUnused(v.shot); lastAdded = new Set(); save(); toast("התו נמחק לצמיתות", s);
  }

  // more actions
  let moreId = null;
  const MENU = {
    active: [["show", "i-qr", "הצגה בקופה"], ["used", "i-check", "סימון כמומש"], ["part", "i-part", "מימוש חלקי"], ["edit", "i-edit", "עריכת פרטים"], ["trash", "i-trash", "מחיקה", true]],
    pdf:    [["show", "i-qr", "הצגה בקופה"], ["used", "i-check", "השתמשתי (סימון כמומש)"], ["unexport", "i-undo", "לא השתמשתי (ביטול הסימון)"], ["part", "i-part", "מימוש חלקי"], ["edit", "i-edit", "עריכת פרטים"], ["trash", "i-trash", "מחיקה", true]],
    used:   [["unuse", "i-undo", "החזרה לפעילים"], ["trash", "i-trash", "מחיקה", true]],
    trash:  [["restore", "i-undo", "שחזור"], ["purge", "i-trash", "מחיקה לצמיתות", true]]
  };
  function openMore(v, kind){
    moreId = v.id;
    $("moreTitle").textContent = "התו " + vName(v);
    $("moreSub").textContent = codeTxt(v);
    const m = $("moreMenu"); m.innerHTML = "";
    MENU[kind || "active"].forEach(([act, icon, label, danger]) => {
      const b = el("button", danger ? "danger" : ""); b.type = "button";
      b.innerHTML = `<svg aria-hidden="true"><use href="#${icon}"/></svg>`; b.append(document.createTextNode(label));
      b.onclick = () => {
        const it = items.find(x => x.id === moreId); $("moreSheet").close(); if(!it) return;
        ({ show: () => openReader(it.id), used: () => doUsed(it), part: () => openPartial(it), edit: () => openEdit(it),
           trash: () => doTrash(it), unuse: () => doUnuse(it), unexport: () => doUnexport(it), restore: () => doRestore(it), purge: () => doPurge(it) })[act]();
      };
      m.append(b);
    });
    openSheet($("moreSheet"));
  }

  // partial use
  let partId = null;
  function openPartial(v){
    partId = v.id;
    const bal = balOf(v);
    $("partSub").textContent = bal != null ? `התו ${codeTxt(v)}. היתרה כרגע ${money(bal)}.` : `לתו ${codeTxt(v)} עוד אין יתרה. אפשר להזין אותה בעריכת פרטים.`;
    $("partAmt").value = ""; $("partErr").textContent = ""; $("partAmt").disabled = bal == null; $("partOk").disabled = bal == null;
    openSheet($("partSheet"));
    if(bal != null) $("partAmt").focus();
  }
  $("partOk").onclick = async () => {
    const v = items.find(x => x.id === partId); if(!v) return;
    const x = parseMoney($("partAmt").value), bal = balOf(v);
    if(!(x > 0)){ $("partErr").textContent = "הקלידו כמה שקלים מימשתם."; $("partAmt").focus(); return; }
    const left = Math.round((bal - x) * 100) / 100;
    $("partSheet").close();
    const ok = await ask(left > 0
      ? { title: `לעדכן את היתרה ל-${money(left)}?`, text: `מימשת ${money(x)} מהתו ${codeTxt(v)}, שהיתרה שלו ${money(bal)}.`, ok: "עדכון היתרה" }
      : { title: "לסמן את התו כמומש?", text: `מימשת ${money(x)} מהתו ${codeTxt(v)}, וזו כל היתרה שלו (${money(bal)}).`, ok: "סימון כמומש" });
    if(!ok) return;
    const s = snapshot();
    if(left > 0){
      v.balance = left; v.balanceSetAt = Date.now(); if(v.loadAmount == null) v.loadAmount = bal;
      lastAdded = new Set([v.code]); save(); if(curId === v.id) openReader(v.id);
      toast("היתרה עודכנה ל-" + money(left), s, 8000);
    } else {
      const n = curId === v.id ? nextAfter(v.id) : null;
      v.balance = 0; v.balanceSetAt = Date.now(); v.used = true; v.usedAt = Date.now(); lastAdded = new Set(); save();
      if(curId === v.id){ if(n && n.id !== v.id) openReader(n.id); else closeReader(); }
      toast("כל היתרה נוצלה, התו סומן כמומש", s, 8000);
    }
  };

  // edit
  let editId = null;
  function openEdit(v){
    editId = v.id;
    $("editSub").textContent = codeTxt(v);
    $("eBal").value = balOf(v) ?? ""; $("eLoad").value = v.loadAmount ?? ""; $("eDate").value = v.loaded || "";
    showUntil(); openSheet($("editSheet"));
  }
  function showUntil(){ const d = $("eDate").value; $("eUntil").textContent = d ? "בתוקף עד " + isoToHe(plusYears(d, 5)) : ""; }
  $("eDate").oninput = showUntil;
  $("eSave").onclick = async () => {
    const v = items.find(x => x.id === editId); if(!v) return;
    const nb = parseMoney($("eBal").value), nl = parseMoney($("eLoad").value), nd = $("eDate").value || null;
    const ch = [];
    if(nb !== balOf(v)) ch.push(`יתרה: ${balOf(v) != null ? money(balOf(v)) : "ריק"} ← ${nb != null ? money(nb) : "ריק"}`);
    if(nl !== (v.loadAmount ?? null)) ch.push(`הוטען: ${v.loadAmount != null ? money(v.loadAmount) : "ריק"} ← ${nl != null ? money(nl) : "ריק"}`);
    if(nd !== (v.loaded || null)) ch.push(`תאריך הטענה: ${v.loaded ? isoToHe(v.loaded) : "ריק"} ← ${nd ? isoToHe(nd) : "ריק"}`);
    $("editSheet").close();
    if(!ch.length) return;
    if(!await ask({ title: "לשמור את השינויים?", text: ch.join(". ") + ".", ok: "שמירה" })) return;
    const s = snapshot();
    v.balance = nb; v.balanceSetAt = Date.now(); v.loadAmount = nl; v.loaded = nd; delete v.expiry;
    lastAdded = new Set([v.code]); save(); toast("השינויים נשמרו", s);
  };

  // ---------- settings: backup and reset ----------
  $("setBtn").onclick = () => openSheet($("setSheet"));
  function backupFile(){
    return new File([JSON.stringify({ app: "tavim", version: 3, made: new Date().toISOString(), items, shots }, null, 1)], "tavim-backup-" + todayIso() + ".json", { type: "application/json" });
  }
  function backedUp(){ bk.lastAt = Date.now(); bk.changes = 0; bk.snooze = 0; try { localStorage.setItem(LS_BK, JSON.stringify(bk)); } catch(e){} backupUi(); }
  function backupUi(){
    const days = bk.lastAt ? Math.floor((Date.now() - bk.lastAt) / 864e5) : null;
    const when = days === null ? "עוד לא נשמר קובץ גיבוי." : days === 0 ? "גיבוי אחרון: היום." : days === 1 ? "גיבוי אחרון: אתמול." : `גיבוי אחרון: לפני ${days} ימים.`;
    $("backupState").textContent = when + (bk.changes && days !== null ? (bk.changes === 1 ? " שינוי אחד מאז." : ` ${bk.changes} שינויים מאז.`) : "");
    const has = items.some(v => !v.deleted);
    const due = has && Date.now() > bk.snooze && (days === null ? bk.changes >= 3 : (bk.changes >= 15 || (bk.changes >= 1 && days >= 14)));
    $("backupNote").hidden = !due || selecting;
    if(due) $("backupNoteTxt").textContent = days === null
      ? "התווים שמורים רק בטלפון הזה, ועוד לא נשמר להם גיבוי. אם נתוני הדפדפן יימחקו, הם יאבדו."
      : `${bk.changes === 1 ? "שינוי אחד" : bk.changes + " שינויים"} מאז הגיבוי האחרון, ${days === 0 ? "היום" : days === 1 ? "אתמול" : "לפני " + days + " ימים"}.`;
    $("shareBackupBtn").hidden = !(navigator.canShare && navigator.canShare({ files: [backupFile()] }));
  }
  $("backupNow").onclick = () => openSheet($("setSheet"));
  $("backupLater").onclick = () => { bk.snooze = Date.now() + 3 * 864e5; try { localStorage.setItem(LS_BK, JSON.stringify(bk)); } catch(e){} backupUi(); };
  $("shareBackupBtn").onclick = async () => {
    try { await navigator.share({ files: [backupFile()], title: "גיבוי התווים שלי" }); backedUp(); toast("הגיבוי נשלח", null); } catch(e){}
  };
  $("exportBtn").onclick = () => {
    const f = backupFile();
    const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    backedUp(); toast("קובץ הגיבוי נשמר בהורדות", null);
  };
  $("snapsBtn").onclick = () => {
    $("setSheet").close();
    const box = $("snapList"); box.innerHTML = "";
    const list = snaps.slice().reverse();
    if(!list.length) box.append(el("p", "sub", "עוד אין עותקים. העותק הראשון נשמר בפעם הבאה שהרשימה משתנה."));
    list.forEach(sn => {
      let arr = []; try { arr = cleanList(JSON.parse(sn.items)); } catch(e){}
      const live = arr.filter(v => !v.used && !v.deleted), sum = live.reduce((t, v) => t + (v.balance ?? v.loadAmount ?? v.amount ?? 0), 0);
      const b = el("button"); b.type = "button";
      b.append(document.createTextNode(`${isoToHe(sn.day)}: ${live.length === 1 ? "תו פעיל אחד" : live.length + " תווים פעילים"}${sum ? ", " + money(sum) : ""}`));
      b.onclick = async () => {
        $("snapSheet").close();
        if(!await ask({ title: `לשחזר את הרשימה מ-${isoToHe(sn.day)}?`, text: `הרשימה הנוכחית תוחלף בעותק הזה (${arr.length === 1 ? "תו אחד" : arr.length + " תווים"} בסך הכול). אפשר לבטל מיד אחרי.`, ok: "שחזור" })) return;
        const s0 = snapshot(); items = arr.map(migrate); lastAdded = new Set(); tab = "active"; save(); toast("הרשימה שוחזרה", s0, 12000);
      };
      box.append(b);
    });
    openSheet($("snapSheet"));
  };
  $("importFile").onchange = async (ev) => {
    const f = ev.target.files[0]; ev.target.value = ""; if(!f) return;
    $("setSheet").close();
    let d;
    try { if(f.size > 5e6) throw new Error("too big"); d = JSON.parse(await f.text()); if(!d || typeof d !== "object") throw new Error("bad"); } catch(e){ return tell({ title: "לא ניתן לטעון את הקובץ", text: "זה לא קובץ גיבוי של האפליקציה. בחרו קובץ ששמו מתחיל ב-tavim-backup.", kind: "danger", icon: "!" }); }
    const inc = cleanList(Array.isArray(d) ? d : d.items);
    const known = new Set(items.map(v => v.code));
    const fresh = inc.filter(v => !known.has(v.code));
    if(!fresh.length) return tell({ title: "אין תווים חדשים בגיבוי", text: "כל התווים שבקובץ כבר נמצאים ברשימה.", kind: "", icon: "i" });
    if(!await ask({ title: fresh.length === 1 ? "לטעון תו אחד מהגיבוי?" : `לטעון ${fresh.length} תווים מהגיבוי?`, text: "התווים יתווספו לרשימה. תווים שכבר קיימים לא ישתנו.", ok: "טעינה" })) return;
    const s = snapshot();
    const ids = new Set(items.map(v => v.id));
    fresh.forEach(v => { if(ids.has(v.id)) v.id = uid(); ids.add(v.id); items.push(migrate(v)); });
    cleanShots(d.shots).forEach(rememberShot);
    save(); toast(fresh.length === 1 ? "נטען תו אחד" : `נטענו ${fresh.length} תווים`, s);
  };
  $("resetShotsBtn").onclick = async () => {
    $("setSheet").close();
    if(!await ask({ title: "לאפס את זיכרון הצילומים?", text: "אפשר יהיה להעלות שוב צילומים שכבר נקראו. רשימת התווים לא תשתנה.", ok: "איפוס" })) return;
    const s = snapshot(); shots = []; run.hashes.clear(); save();
    toast("זיכרון הצילומים אופס", s);
  };
  $("resetAllBtn").onclick = async () => {
    $("setSheet").close();
    const n = items.length;
    if(!await ask({ title: "למחוק את כל התווים?", text: `${n ? (n === 1 ? "תו אחד יימחק" : `${n} תווים יימחקו`) + ", כולל הממומשים והפח." : "הרשימה ריקה כבר."} מומלץ לשמור קודם קובץ גיבוי.`, ok: "מחיקת הכול", danger: true, icon: "!" })) return;
    const s = snapshot();
    items = []; shots = []; run.hashes.clear(); lastAdded = new Set();
    [...$("rvList").children].forEach(c => dropCard(c, true));
    tab = "active"; save(); setStatus(""); window.scrollTo(0, 0);
    toast("כל התווים נמחקו", s, 12000);
  };

  // ---------- PDF: choose vouchers, export, then mark them used or not ----------
  let selecting = false;
  const selected = new Set();
  function enterSelect(){
    if(!active().length) return tell({ title: "אין תווים פעילים לייצוא", text: "אפשר לייצא רק תווים שעוד לא מומשו.", kind: "", icon: "i" });
    selecting = true; selected.clear(); tab = "active"; lastAdded = new Set(); render(); arm(); window.scrollTo(0, 0);
  }
  function updateSelUi(){
    const act = active();
    const sum = act.filter(v => selected.has(v.id)).reduce((s, v) => s + (balOf(v) || 0), 0);
    $("selCount").textContent = selected.size ? `נבחרו ${selected.size}${sum ? ", בסך " + money(sum) : ""}` : "בחרו תווים לייצוא";
    $("selAll").textContent = selected.size === act.length ? "ניקוי הבחירה" : "בחירת הכול";
    $("selGo").textContent = selected.size ? `המשך (${selected.size})` : "המשך";
    $("selGo").disabled = !selected.size;
  }
  // One listener for the whole list: a tap anywhere on a row (the box included) ticks or
  // unticks it in place. The list is not rebuilt, and a doubled tap event is ignored.
  let lastTap = { id: null, t: 0 };
  $("list").addEventListener("click", e => {
    if(!selecting) return;
    const li = e.target.closest(".row"); if(!li || !li.dataset.id) return;
    e.preventDefault();
    const id = li.dataset.id, now = performance.now();
    if(lastTap.id === id && now - lastTap.t < 250) return;
    lastTap = { id, t: now };
    const on = !selected.has(id);
    if(on) selected.add(id); else selected.delete(id);
    li.classList.toggle("sel", on);
    const m = li.querySelector(".row-main"); if(m) m.setAttribute("aria-checked", String(on));
    updateSelUi();
  });
  function exitSelect(){ selecting = false; selected.clear(); render(); maybeDisarm(); }
  $("pdfBtn").onclick = () => selecting ? exitSelect() : enterSelect();
  $("selCancel").onclick = exitSelect;
  $("selAll").onclick = () => { const act = active(); if(selected.size === act.length) selected.clear(); else act.forEach(v => selected.add(v.id)); render(); };
  $("selGo").onclick = () => openPdfSheet();

  async function doUnexport(v){
    if(!await ask({ title: `לבטל את סימון הייצוא של התו ${vName(v)}?`, text: `מספר ${codeTxt(v)}. התו נשאר פעיל, ורק יוצא מהלשונית ״יוצאו״.`, ok: "ביטול הסימון" })) return;
    const s = snapshot(); delete v.exportedAt; delete v.exportFmt; lastAdded = new Set(); save(); toast("סימון הייצוא בוטל", s);
  }
  $("pdfClearAll").onclick = async () => {
    const list = active().filter(v => v.exportedAt);
    if(!await ask({ title: `לבטל את סימון הייצוא של ${list.length === 1 ? "תו אחד" : list.length + " תווים"}?`, text: "התווים נשארים פעילים, ורק יוצאים מהלשונית ״יוצאו״.", ok: "ביטול הסימון" })) return;
    const s = snapshot(); list.forEach(v => { delete v.exportedAt; delete v.exportFmt; }); save(); toast("הסימון בוטל", s);
  };

  const PDF_FMTS = [
    ["CODE128", "Code 128", "ברקוד רגיל, הנפוץ בקופות"],
    ["CODE39", "Code 39", "ברקוד רחב, נקרא כמעט בכל סורק"],
    ["QR", "QR", "קוד ריבועי, לסורקים מבוססי מצלמה"],
    ["EAN13", "EAN-13", "ברקוד מוצרים, רק למספרים מתאימים"]
  ];
  let pdfFmt = localStorage.getItem("victory-pdffmt") || "CODE128", pdfBlob = null, pdfName = "";
  function pdfChosen(){ return active().filter(v => selected.has(v.id)); }
  function openPdfSheet(){
    const list = pdfChosen(); if(!list.length) return;
    const sum = list.reduce((s, v) => s + (balOf(v) || 0), 0);
    $("pdfTitle").textContent = "ייצוא ל-PDF";
    $("pdfSub").textContent = `${list.length === 1 ? "תו אחד" : list.length + " תווים"}${sum ? ", בסך " + money(sum) : ""}. לכל תו יופיעו קוד, המספר, היתרה ותאריך ההטענה.`;
    const eanOk = list.every(v => ean13ok(v.code));
    if(pdfFmt === "EAN13" && !eanOk) pdfFmt = "CODE128";
    const box = $("pdfFmt"); box.innerHTML = "";
    PDF_FMTS.forEach(([id, label, desc]) => {
      const b = el("button"); b.type = "button"; b.append(el("b", null, label), el("span", null, desc));
      b.setAttribute("aria-pressed", String(id === pdfFmt));
      if(id === "EAN13" && !eanOk) b.disabled = true;
      b.onclick = () => { pdfFmt = id; try { localStorage.setItem("victory-pdffmt", id); } catch(e){} box.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); drawColsPicker(true); };
      box.append(b);
    });
    $("pdfHint").textContent = eanOk ? "" : "EAN-13 לא זמין, כי לפחות אחד המספרים שנבחרו לא מתאים לו.";
    drawColsPicker(true);
    $("pdfOpts").hidden = false; $("pdfWork").hidden = true; $("pdfDone").hidden = true;
    openSheet($("pdfSheet"));
  }

  // How many vouchers per row. Each code type has a recommended number, which is the default.
  // The recommendations come from reading the finished PDF with a barcode reader at several
  // resolutions: every size was readable in a sharp print, the recommended one also in a poor one.
  const PDF_LAYOUT = { 2: { rows: 4, k: 1, gap: 32 }, 3: { rows: 6, k: 0.68, gap: 26 }, 4: { rows: 8, k: 0.5, gap: 20 } };
  const PDF_COLS = { CODE128: { rec: 3 }, EAN13: { rec: 3 }, QR: { rec: 2 }, CODE39: { rec: 2 } };
  let pdfCols = 3;
  function drawColsPicker(reset){
    const rule = PDF_COLS[pdfFmt] || PDF_COLS.CODE128;
    if(reset) pdfCols = rule.rec;
    const box = $("pdfCols"); box.innerHTML = "";
    [2, 3, 4].forEach(n => {
      const per = n * PDF_LAYOUT[n].rows;
      const b = el("button"); b.type = "button";
      b.append(el("b", null, `${n} בשורה`), el("span", null, `${per} בעמוד`));
      if(n === rule.rec) b.append(el("span", "rec", "מומלץ"));
      b.setAttribute("aria-pressed", String(n === pdfCols));
      b.onclick = () => { pdfCols = n; drawColsPicker(false); };
      box.append(b);
    });
    const why = {
      CODE128: "ההמלצה שלי: 3 בשורה. הברקוד נקרא גם בהדפסה חלשה, ונכנסים 18 תווים בעמוד. 4 בשורה חוסך נייר, אבל דורש הדפסה חדה והטקסט קטן.",
      EAN13: "ההמלצה שלי: 3 בשורה. הברקוד נקרא גם בהדפסה חלשה, ונכנסים 18 תווים בעמוד. 4 בשורה חוסך נייר, אבל דורש הדפסה חדה.",
      QR: "ההמלצה שלי: 2 בשורה. בבדיקות, קוד QR קטן לא תמיד נקרא, ולכן עדיף להשאיר אותו גדול.",
      CODE39: "ההמלצה שלי: 2 בשורה. Code 39 הוא ברקוד רחב, וביותר מ-2 בשורה הקווים שלו נעשים דקים ורגישים לאיכות ההדפסה."
    };
    $("pdfColsHint").textContent = why[pdfFmt] || "";
  }

  function loadScript(src){
    return new Promise((res, rej) => { const t = document.createElement("script"); t.src = src; t.onload = res; t.onerror = rej; document.head.append(t); });
  }
  const FONT = '"IBM Plex Sans Hebrew", "Rubik", Arial, sans-serif';
  function codeCanvas(v, fmt, maxW, maxH){
    if(fmt === "QR"){
      const q = qrcode(0, "M"); q.addData(v.code); q.make();
      const n = q.getModuleCount(), quiet = 4, sc = Math.max(3, Math.floor(Math.min(maxW, maxH || 300) / (n + quiet * 2)));   // whole pixels per square, drawn without resizing
      const c = document.createElement("canvas"); c.width = c.height = (n + quiet * 2) * sc;
      const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.fillStyle = "#000";
      for(let r = 0; r < n; r++) for(let k = 0; k < n; k++) if(q.isDark(r, k)) x.fillRect((k + quiet) * sc, (r + quiet) * sc, sc, sc);
      return c;
    }
    const value = fmt === "EAN13" ? v.code.slice(0, 12) : v.code;
    const probe = document.createElement("canvas");
    JsBarcode(probe, value, { format: fmt, width: 1, height: 10, margin: 10, displayValue: false });
    const mod = Math.max(2, Math.min(5, Math.floor(maxW / probe.width)));   // whole pixels per bar, so bars stay sharp
    const c = document.createElement("canvas");
    const barH = Math.max(50, Math.min(150, Math.floor((maxH || 190) - 20 * mod)));
    JsBarcode(c, value, { format: fmt, width: mod, height: barH, margin: 10 * mod, displayValue: false, background: "#fff", lineColor: "#000" });
    return c;
  }
  async function buildPdf(list, fmt, cols){
    if(!window.jspdf) await loadScript("lib-jspdf.min.js");
    try { await Promise.all(["400", "500", "600"].map(w => document.fonts.load(`${w} 30px "IBM Plex Sans Hebrew"`))); } catch(e){}
    const L = PDF_LAYOUT[cols] || PDF_LAYOUT[3];
    const W = 1654, H = 2339, M = 96, GAP = L.gap, HEAD = 120, COLS = cols, ROWS = L.rows, PER = COLS * ROWS;
    const k = L.k, z = n => Math.round(n * k);
    const cw = (W - 2 * M - GAP * (COLS - 1)) / COLS, ch = (H - 2 * M - HEAD - GAP * (ROWS - 1)) / ROWS;
    const pages = Math.ceil(list.length / PER), made = new Date();
    const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4", compress: true });
    for(let pIdx = 0; pIdx < pages; pIdx++){
      $("pdfWorkTxt").textContent = pages > 1 ? `יוצר עמוד ${pIdx + 1} מתוך ${pages}…` : "יוצר את הקובץ…";
      await new Promise(r => setTimeout(r, 0));
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      const x = c.getContext("2d");
      x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
      // page header
      x.direction = "rtl"; x.textAlign = "right"; x.fillStyle = "#141414"; x.font = `600 40px ${FONT}`;
      x.fillText("התווים שלי", W - M, M + 40);
      x.font = `400 26px ${FONT}`; x.fillStyle = "#666663";
      x.fillText(`נוצר ב-${fmtDate(made.getTime())}, ${list.length === 1 ? "תו אחד" : list.length + " תווים"}`, W - M, M + 84);
      x.textAlign = "left"; x.direction = "rtl";
      x.fillText(`עמוד ${pIdx + 1} מתוך ${pages}`, M, M + 40);
      x.fillStyle = "#e4e4e2"; x.fillRect(M, M + HEAD - 14, W - 2 * M, 2);
      list.slice(pIdx * PER, pIdx * PER + PER).forEach((v, i) => {
        const col = i % COLS, rowN = Math.floor(i / COLS);
        const cx = W - M - (col + 1) * cw - col * GAP;          // first card on the right, as in Hebrew
        const cy = M + HEAD + rowN * (ch + GAP);
        x.strokeStyle = "#d4d4d1"; x.lineWidth = 2;
        x.beginPath(); x.roundRect(cx, cy, cw, ch, z(22)); x.stroke();
        const pad = z(30), n = pIdx * PER + i + 1;
        // top line: balance on the right, number in the list on the left
        x.direction = "rtl"; x.textAlign = "right"; x.fillStyle = "#141414"; x.font = `600 ${z(42)}px ${FONT}`;
        const bal = balOf(v); x.fillText(bal != null ? money(bal) : "ללא יתרה", cx + cw - pad, cy + z(62));
        if(bal != null && v.loadAmount != null && v.loadAmount !== bal){
          const wAmt = x.measureText(money(bal)).width;
          x.font = `400 ${z(24)}px ${FONT}`; x.fillStyle = "#666663"; x.fillText("מתוך " + money(v.loadAmount), cx + cw - pad - wAmt - z(14), cy + z(62));
        }
        x.textAlign = "left"; x.font = `500 ${z(26)}px ${FONT}`; x.fillStyle = "#8f8f8b"; x.direction = "ltr";
        x.fillText("#" + n, cx + pad, cy + z(58));
        // the code itself, drawn at whole-pixel bar widths and never stretched
        const top = cy + z(84), room = ch - z(84) - z(150);
        const img = codeCanvas(v, fmt, cw - 2 * pad, room);
        let iw = img.width, ih = img.height;
        if(iw > cw - 2 * pad){ const f = (cw - 2 * pad) / iw; iw *= f; ih *= f; }
        x.imageSmoothingEnabled = false;
        x.drawImage(img, Math.round(cx + (cw - iw) / 2), Math.round(top + (room - ih) / 2), iw, ih);
        // number and date, for recognising the voucher
        x.direction = "ltr"; x.textAlign = "center"; x.fillStyle = "#141414"; x.font = `600 ${z(38)}px ${FONT}`;
        x.fillText(group(v.code).join("  "), cx + cw / 2, cy + ch - z(100));
        x.direction = "rtl"; x.font = `400 ${z(24)}px ${FONT}`; x.fillStyle = "#666663";
        const parts = [];
        if(v.loaded) parts.push("הוטען ב-" + isoToHe(v.loaded));
        if(v.loaded) parts.push("בתוקף עד " + isoToHe(plusYears(v.loaded, 5)));
        x.fillText(parts.join(", "), cx + cw / 2, cy + ch - z(62));
        // a box to tick by hand
        const bx = z(24);
        x.strokeStyle = "#8f8f8b"; x.lineWidth = 2; x.strokeRect(cx + pad, cy + ch - z(22) - bx, bx, bx);
        x.direction = "rtl"; x.textAlign = "left"; x.fillStyle = "#8f8f8b"; x.font = `400 ${z(21)}px ${FONT}`;
        x.fillText("מומש", cx + pad + bx + z(10), cy + ch - z(22) - z(5));
      });
      if(pIdx) doc.addPage();
      doc.addImage(c.toDataURL("image/png"), "PNG", 0, 0, 210, 297, undefined, "FAST");
    }
    return doc.output("blob");
  }
  $("pdfMake").onclick = async () => {
    const list = pdfChosen(); if(!list.length) return;
    $("pdfOpts").hidden = true; $("pdfWork").hidden = false;
    try{
      pdfBlob = await buildPdf(list, pdfFmt, pdfCols);
    }catch(e){
      $("pdfSheet").close();
      return tell({ title: "לא הצלחתי ליצור את הקובץ", text: "ייתכן שאין חיבור לאינטרנט בפעם הראשונה שיוצרים PDF. נסו שוב בעוד רגע.", kind: "danger", icon: "!" });
    }
    pdfName = `tavim-${todayIso()}.pdf`;
    const s = snapshot(), now = Date.now();
    list.forEach(v => { v.exportedAt = now; v.exportFmt = pdfFmt; });
    selecting = false; selected.clear(); tab = "pdf"; lastAdded = new Set(list.map(v => v.code)); save();
    $("pdfTitle").textContent = "ה-PDF מוכן";
    $("pdfSub").textContent = `${list.length === 1 ? "התו סומן" : list.length + " התווים סומנו"} בלשונית ״יוצאו״. אחרי השימוש, סמנו שם לכל תו אם השתמשתם בו.`;
    const file = new File([pdfBlob], pdfName, { type: "application/pdf" });
    $("pdfShare").hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    $("pdfWork").hidden = true; $("pdfDone").hidden = false;
    toast(list.length === 1 ? "התו סומן כ״יוצא״" : `${list.length} תווים סומנו כ״יוצאו״`, s);
  };
  $("pdfShare").onclick = async () => {
    try { await navigator.share({ files: [new File([pdfBlob], pdfName, { type: "application/pdf" })], title: "התווים שלי" }); } catch(e){}
  };
  $("pdfSave").onclick = () => {
    const a = document.createElement("a"); a.href = URL.createObjectURL(pdfBlob); a.download = pdfName;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("הקובץ נשמר בהורדות", null);
  };

  // ---------- at the till ----------
  let curId = null, wakeLock = null;
  // Barcode types. Code 128 is what most shop scanners read; Code 39 and EAN-13 are fallbacks.
  const FMT_KEY = "victory-barfmt";
  let barFmt = localStorage.getItem(FMT_KEY) || "CODE128";
  function fmtsFor(v){
    const f = [["CODE128", "Code 128"], ["CODE39", "Code 39"]];
    if(ean13ok(v.code)) f.push(["EAN13", "EAN-13"]);
    return f;
  }
  function drawCode(v){
    const bar = $("rBar"), list = fmtsFor(v);
    let fmt = list.some(f => f[0] === barFmt) ? barFmt : "CODE128";
    let ok = false;
    try{
      if(window.JsBarcode){
        const value = fmt === "EAN13" ? v.code.slice(0, 12) : v.code;
        // wide bars and a quiet zone of more than 10 bar widths on each side, which scanners need
        JsBarcode(bar, value, { format: fmt, lineColor: "#000", background: "#fff", width: 3, height: 130, margin: 36, fontSize: 22, textMargin: 6, font: "monospace", displayValue: true });
        ok = true;
      }
    }catch(e){}
    $("rBarBox").hidden = !ok;
    const seg = $("barFmt"); seg.innerHTML = "";
    list.forEach(([id, label]) => {
      const b = el("button", null, label); b.type = "button"; b.setAttribute("aria-pressed", String(id === fmt));
      b.onclick = () => { barFmt = id; try { localStorage.setItem(FMT_KEY, id); } catch(e){} drawCode(v); };
      seg.append(b);
    });
  }
  function openReader(id){
    const act = active(); const v = act.find(x => x.id === id); if(!v){ closeReader(); return; }
    curId = id;
    $("rPos").textContent = act.length > 1 ? `תו ${act.indexOf(v)+1} מתוך ${act.length}` : "";
    const rb = $("rBal"); rb.innerHTML = "";
    const bal = balOf(v);
    if(bal != null){
      rb.append(el("div", "lbl", "יתרה"));
      const a = el("div", "amt"); a.append(moneyHtml(bal)); rb.append(a);
      if(v.loadAmount != null && v.loadAmount !== bal) rb.append(el("div", "of", "מתוך " + money(v.loadAmount)));
    }
    const g = $("rGroups"); g.innerHTML = "";
    group(v.code).forEach(s => g.append(el("span", null, s)));
    g.setAttribute("aria-label", v.code);
    const exp = expiryOf(v), parts = [];
    if(v.loaded) parts.push("הוטען ב-" + isoToHe(v.loaded));
    if(exp && daysLeft(exp) <= 30) parts.push((daysLeft(exp) < 0 ? "פג תוקף ב-" : "בתוקף עד ") + isoToHe(exp));
    $("rMeta").textContent = parts.join(". ");
    drawCode(v);
    $("rNext").hidden = act.length < 2;
    $("rPartBtn").classList.toggle("wide", act.length < 2);
    const wasOpen = $("reader").classList.contains("open");
    $("reader").classList.add("open"); $("rClose").focus();
    if(!wasOpen) arm();
    if(!wakeLock && navigator.wakeLock) navigator.wakeLock.request("screen").then(l => { wakeLock = l; }).catch(() => {});
  }
  function closeReader(){ $("reader").classList.remove("open"); curId = null; if(wakeLock){ wakeLock.release().catch(() => {}); wakeLock = null; } maybeDisarm(); }
  function nextAfter(id){ const act = active(); const i = act.findIndex(x => x.id === id); return act.length ? act[(i+1) % act.length] : null; }
  $("rClose").onclick = closeReader;
  $("rNext").onclick = () => { const n = nextAfter(curId); if(n) openReader(n.id); };
  $("rPartBtn").onclick = () => { const v = items.find(x => x.id === curId); if(v) openPartial(v); };
  $("rUsed").onclick = async () => {
    const v = items.find(x => x.id === curId); if(!v) return closeReader();
    const n = nextAfter(curId);
    if(!await doUsed(v)) return;
    if(n && n.id !== v.id) openReader(n.id); else closeReader();
  };
  document.addEventListener("keydown", e => { if(e.key === "Escape" && curId && !document.querySelector("dialog[open]")) closeReader(); });

  render();
})();
