/**
 * 角色征集：同一《剧本》+角色名，被 3 个不同访客提交后，
 * 对 12 维取平均并自动入心测池。
 * 兼容 index.html 中的 Community.getActiveRoles(roles)
 */
(function (global) {
  const THRESHOLD = 3;
  const STORAGE_KEY = "juben_community_submissions_v2";
  const VISITOR_KEY = "juben_community_visitor_v1";
  // 公开云端库：10 个分片，每片最多约 300 条 / 60KB，合计约 3000 条
  const CLOUD_BASE = "https://mantledb.sh/v2/juben-tiepi-public-v1/";
  const CLOUD_LEGACY = CLOUD_BASE + "community";
  const SHARD_COUNT = 10;
  const MAX_PER_SHARD = 300;
  const MAX_SUBMISSIONS = SHARD_COUNT * MAX_PER_SHARD;
  const MAX_SHARD_BYTES = 60000;
  const TEXT_MAX = 50;
  const CLOUD_EPOCH = "2026-08-21T18:35:00.000Z"; // 早于此的本机缓存忽略，避免删库后又被写回

  const DIM_LABELS = [
    "行动欲", "共情", "野心", "羁绊", "掌控", "牺牲",
    "理想", "敏感", "自我", "灰度", "输出", "情爱",
  ];
  const DIM_HINTS = [
    "推进局势、找第三条路、不愿干等",
    "体谅他人、先问对方怎么想",
    "要结果、要位置、想把事做成",
    "护自己人、偏爱、关键时刻站队",
    "冷静布局、掌握信息与节奏",
    "肯付出、肯背锅、肯替人扛",
    "原则、苍生、有些线绝不退",
    "缺安全感、内耗、怕被放下",
    "不被替决定、要自由与尊严",
    "能接受不漂亮的手段与代价",
    "敢说敢演、互动感、舞台欲",
    "恋爱浓度、偏爱、占有与被选",
  ];

  let remoteSubmissions = [];
  let remotePool = [];
  let groupsCache = [];

  function uid() {
    return "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function getVisitorId() {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id) {
      id = uid();
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  }

  function newVisitorId() {
    const id = uid();
    localStorage.setItem(VISITOR_KEY, id);
    return id;
  }

  function canonicalBook(s) {
    const raw = String(s || "").trim().replace(/^《|》$/g, "");
    const aliases = {
      暗夜将至: "暗夜降至",
      南墙二: "南墙贰",
    };
    return aliases[raw] || raw;
  }

  function canonicalName(s) {
    const raw = String(s || "").trim();
    const aliases = {
      怀宁: "怀宁公主",
      晏栖: "宴栖",
      黛丽拉: "黛利拉",
    };
    return aliases[raw] || raw;
  }

  function norm(s) {
    return String(s || "")
      .trim()
      .replace(/^《|》$/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function roleKey(book, name) {
    return norm(canonicalBook(book)) + "|" + norm(canonicalName(name));
  }

  function loadLocal() {
    try {
      const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(list)) return [];
      // 丢弃清空时间点之前的本机记录
      return list.filter((s) => String(s.at || "") >= CLOUD_EPOCH);
    } catch (e) {
      return [];
    }
  }

  function saveLocal(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function clampInt(n) {
    n = Math.round(Number(n));
    if (!isFinite(n)) n = 5;
    return Math.max(1, Math.min(10, n));
  }

  function averageVectors(subs) {
    const v = [];
    for (let i = 0; i < 12; i++) {
      const sum = subs.reduce((a, s) => a + Number(s.v[i] || 5), 0);
      v.push(clampInt(sum / subs.length));
    }
    return v;
  }

  function majorityGender(subs) {
    let f = 0, m = 0;
    subs.forEach((s) => {
      if (s.gender === "female") f++;
      else m++;
    });
    return f >= m ? "female" : "male";
  }

  function clipText(s) {
    return String(s || "").trim().slice(0, TEXT_MAX);
  }

  function pickText(subs, field, fallback) {
    const texts = subs.map((s) => clipText(s[field])).filter(Boolean);
    if (!texts.length) return fallback || "";
    texts.sort((a, b) => b.length - a.length);
    return texts[0];
  }

  function collectNotes(subs) {
    return subs
      .map((s) => ({
        quote: clipText(s.quote),
        why: clipText(s.why),
        risk: clipText(s.risk),
      }))
      .filter((n) => n.quote || n.why || n.risk);
  }

  function splitParts(s) {
    return String(s || "")
      .split(/[，,、/／|]+/)
      .map((x) => x.trim().replace(/^《|》$/g, ""))
      .filter(Boolean);
  }

  function expandCombo(s) {
    if (!s || !s.book || !s.name) return [s];
    const books = splitParts(canonicalBook(s.book)).map(canonicalBook);
    const names = splitParts(s.name);
    if (books.length > 1 && books.length === names.length) {
      return names.map((name, i) => ({ ...s, book: canonicalBook(books[i]), name: canonicalName(name) }));
    }
    return [{ ...s, book: canonicalBook(s.book), name: canonicalName(s.name) }];
  }

  function mergeSubmissions(localList, remoteList) {
    const map = new Map();
    [...remoteList, ...localList].forEach((raw) => {
      expandCombo(raw).forEach((s) => {
        if (!s || !s.book || !s.name || !Array.isArray(s.v) || s.v.length !== 12) return;
        s = { ...s, book: canonicalBook(s.book), name: canonicalName(s.name) };
        const k = roleKey(s.book, s.name) + "::" + (s.visitorId || s.user || "");
        const prev = map.get(k);
        if (!prev || (s.at || "") > (prev.at || "")) map.set(k, s);
      });
    });
    return [...map.values()];
  }

  function officialMap() {
    const m = new Map();
    const base = typeof roles !== "undefined" && Array.isArray(roles) ? roles : [];
    base.forEach((r) => {
      if (r && r.book && r.name) m.set(roleKey(r.book, r.name), r);
    });
    return m;
  }

  function buildGroups(submissions) {
    const groups = new Map();
    submissions.forEach((s) => {
      const k = roleKey(s.book, s.name);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    });

    const official = officialMap();
    const out = [];
    groups.forEach((subs) => {
      const byVisitor = new Map();
      subs.forEach((s) => {
        const vid = s.visitorId || s.user || uid();
        const prev = byVisitor.get(vid);
        if (!prev || (s.at || "") > (prev.at || "")) byVisitor.set(vid, s);
      });
      const unique = [...byVisitor.values()];
      const book = canonicalBook(unique[0].book.replace(/^《|》$/g, "").trim());
      const name = canonicalName(unique[0].name.trim());
      const key = roleKey(book, name);
      const off = official.get(key);
      const ready = !!off || unique.length >= THRESHOLD;
      const forAvg = off ? [{ v: off.v }].concat(unique) : unique.slice(0, THRESHOLD);
      const pooled = ready
        ? {
            book,
            name,
            gender: off ? off.gender : majorityGender(forAvg),
            v: averageVectors(forAvg),
            quote: off ? off.quote : pickText(unique, "quote", "由玩家征集入池的角色。"),
            why: off ? off.why : pickText(unique, "why", "三位玩家为同一角色提交了人格画像，系统取 12 维平均后入池。"),
            risk: off ? off.risk : pickText(unique, "risk", "征集角色仅供娱乐，请以店家官方说明为准。"),
            notes: off ? [] : collectNotes(unique),
            community: !off,
            official: !!off,
            votes: unique.length,
          }
        : null;

      out.push({
        key,
        book,
        name,
        count: unique.length,
        need: off ? unique.length : THRESHOLD,
        inPool: ready,
        official: !!off,
        pooled,
        submissions: unique,
      });
    });

    out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
    return out;
  }

  function refreshGroups() {
    groupsCache = buildGroups(mergeSubmissions(loadLocal(), remoteSubmissions));
    return groupsCache;
  }

  async function fetchCommunityJson() {
    try {
      const res = await fetch("community.json?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.submissions)) {
        remoteSubmissions = mergeSubmissions(remoteSubmissions, data.submissions);
      }
      if (Array.isArray(data.pool)) remotePool = data.pool;
    } catch (e) {}
  }

  function shardUrl(i) {
    return CLOUD_BASE + "c" + i;
  }

  async function fetchCloudDoc(url) {
    try {
      const res = await fetch(url + "?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data === "object" ? data : null;
    } catch (e) {
      return null;
    }
  }

  async function putCloudDoc(url, data) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  function collectSubs(docs) {
    let list = [];
    docs.forEach((data) => {
      if (data && Array.isArray(data.submissions)) list = mergeSubmissions(list, data.submissions);
    });
    return list;
  }

  function packShards(subs) {
    const sorted = subs.slice().sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    let kept = sorted.slice(0, MAX_SUBMISSIONS);
    const shards = [];
    for (let i = 0; i < SHARD_COUNT; i++) {
      let chunk = kept.slice(i * MAX_PER_SHARD, (i + 1) * MAX_PER_SHARD);
      const doc = {
        version: 2,
        shard: i,
        updatedAt: new Date().toISOString(),
        submissions: chunk,
      };
      while (chunk.length > 40 && JSON.stringify(doc).length > MAX_SHARD_BYTES) {
        chunk.pop();
        doc.submissions = chunk;
      }
      shards.push(doc);
    }
    return shards;
  }

  async function fetchCloud() {
    const urls = [CLOUD_LEGACY];
    for (let i = 0; i < SHARD_COUNT; i++) urls.push(shardUrl(i));
    const docs = await Promise.all(urls.map(fetchCloudDoc));
    const submissions = collectSubs(docs);
    remoteSubmissions = mergeSubmissions(remoteSubmissions, submissions);
    return { submissions: remoteSubmissions };
  }

  async function publishToCloud(payload) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = (await fetchCloud()) || { submissions: [] };
      const pieces = expandCombo(payload);
      const nextSubs = mergeSubmissions(cur.submissions || [], pieces);
      const shards = packShards(nextSubs);
      const all = shards.flatMap((s) => s.submissions);
      const writes = shards.map((doc, i) => putCloudDoc(shardUrl(i), doc));
      writes.push(
        putCloudDoc(CLOUD_LEGACY, {
          version: 2,
          sharded: true,
          updatedAt: new Date().toISOString(),
          submissions: shards[0] ? shards[0].submissions : [],
        })
      );
      const okBits = await Promise.all(writes);
      if (okBits.every(Boolean)) {
        remoteSubmissions = all;
        return true;
      }
      await new Promise((r) => setTimeout(r, 200 + attempt * 150));
    }
    return false;
  }

  function parseIssues(issues) {
    // legacy no-op (GitHub Issues sync removed)
  }

  async function fetchGithubIssues() {
    // legacy no-op
  }

  function getCommunityPoolRoles() {
    refreshGroups();
    const fromGroups = groupsCache.filter((g) => g.inPool && g.pooled).map((g) => g.pooled);
    const keys = new Set(fromGroups.map((r) => roleKey(r.book, r.name)));
    remotePool.forEach((r) => {
      if (!r || !r.book || !r.name || !Array.isArray(r.v)) return;
      const k = roleKey(r.book, r.name);
      if (keys.has(k)) return;
      fromGroups.push({ ...r, community: true });
      keys.add(k);
    });
    return fromGroups;
  }

  function getActiveRoles(baseRoles) {
    const base = Array.isArray(baseRoles) ? baseRoles : typeof roles !== "undefined" ? roles : [];
    const extra = getCommunityPoolRoles();
    const merged = base.map((r) => ({ ...r }));
    const seen = new Set(merged.map((r) => roleKey(r.book, r.name)));
    extra.forEach((r) => {
      const k = roleKey(r.book, r.name);
      const idx = merged.findIndex((x) => roleKey(x.book, x.name) === k);
      if (idx >= 0) {
        if (r.v && r.v.length === 12) merged[idx] = { ...merged[idx], v: r.v };
        return;
      }
      seen.add(k);
      const baseRole = typeof R === "function"
        ? R(r.book, r.name, r.gender, r.v, r.quote, r.why, r.risk)
        : { ...r };
      merged.push({
        ...baseRole,
        community: true,
        notes: Array.isArray(r.notes) ? r.notes : [],
      });
    });
    return merged;
  }

  function renderDimSliders() {
    const root = document.getElementById("c_dims");
    if (!root) return;
    root.innerHTML = DIM_LABELS.map((label, i) => {
      return (
        '<div class="c-dim">' +
          '<div class="c-dim-name">' +
            '<span>' + label + '</span>' +
            '<small>' + DIM_HINTS[i] + '</small>' +
          '</div>' +
          '<input type="range" min="1" max="10" value="5" data-i="' + i + '" />' +
          '<b id="c_dim_val_' + i + '">5</b>' +
        '</div>'
      );
    }).join("");
    root.querySelectorAll("input[type=range]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const el = document.getElementById("c_dim_val_" + inp.dataset.i);
        if (el) el.textContent = inp.value;
      });
    });
  }

  function readForm() {
    const book = (document.getElementById("c_book").value || "").trim().replace(/^《|》$/g, "");
    const name = (document.getElementById("c_name").value || "").trim();
    const gender = document.getElementById("c_gender").value || "female";
    const quoteEl = document.getElementById("c_quote");
    const whyEl = document.getElementById("c_why");
    const riskEl = document.getElementById("c_risk");
    const quote = ((quoteEl && quoteEl.value) || "").trim().slice(0, 80);
    const why = clipText((whyEl && whyEl.value) || "");
    const risk = clipText((riskEl && riskEl.value) || "");
    const v = [...document.querySelectorAll("#c_dims input[type=range]")].map((el) =>
      clampInt(el.value)
    );
    return { book: canonicalBook(book), name: canonicalName(name), gender, v, quote, why, risk };
  }

  function setError(msg) {
    const el = document.getElementById("c_error");
    if (!el) return;
    if (!msg) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  function setMeta(msg) {
    const el = document.getElementById("c_meta");
    if (el) el.textContent = msg;
  }

  function renderList() {
    const box = document.getElementById("c_list");
    if (!box) return;
    const groups = refreshGroups();
    if (!groups.length) {
      box.innerHTML =
        '<div class="c-empty">还没有征集。同一角色被 3 人提交后，会按 12 维平均分入池。</div>';
      return;
    }
    box.innerHTML = groups
      .map((g) => {
        const status = g.official
          ? '<span class="c-tag">已在角色池 · 直接平均</span>'
          : g.inPool
          ? '<span class="c-tag">已入池 · 平均向量</span>'
          : '<span class="c-sub">征集中 ' + g.count + "/" + g.need + "</span>";
        const avg = g.official
          ? '<div class="c-brief">已用 ' + g.count + " 份征集分与原画像取平均，无需再凑 3 人。</div>"
          : g.inPool && g.pooled
            ? '<div class="c-brief">入池向量：[' + g.pooled.v.join(", ") + "]</div>"
            : '<div class="c-brief">还差 ' + Math.max(0, g.need - g.count) + " 人提交</div>";
        return (
          '<div class="c-card' + (g.inPool ? " inpool" : "") + '">' +
          '<div class="c-card-top"><div>' +
          '<div class="c-tag">《' + g.book + "》</div>" +
          "<h3>" + g.name + "</h3>" + status +
          "</div>" +
          '<div class="c-votes">' + g.count + "</div>" +
          "</div>" + avg + "</div>"
        );
      })
      .join("");
  }

  function submitFromForm(publishRemote) {
    setError("");
    const data = readForm();
    if (!data.book || !data.name) {
      setError("请填写剧本名和角色名。");
      return null;
    }
    if (data.v.length !== 12) {
      setError("请完整拖动 12 维分数。");
      return null;
    }

    const payload = {
      book: data.book,
      name: data.name,
      gender: data.gender,
      v: data.v,
      quote: data.quote,
      why: data.why,
      risk: data.risk,
      visitorId: getVisitorId(),
      at: new Date().toISOString(),
    };

    const list = loadLocal().filter(
      (s) =>
        !(
          roleKey(s.book, s.name) === roleKey(payload.book, payload.name) &&
          s.visitorId === payload.visitorId
        )
    );
    list.push(payload);
    saveLocal(list);
    refreshGroups();
    renderList();
    return payload;
  }

  async function submitAndSync() {
    const payload = submitFromForm(true);
    if (!payload) return;
    setMeta("正在同步到全网…");
    setError("");
    const ok = await publishToCloud(payload);
    refreshGroups();
    renderList();
    if (typeof global.renderHomeRoster === "function") global.renderHomeRoster();
    const g = groupsCache.find((x) => x.key === roleKey(payload.book, payload.name));
    if (!ok) {
      setError("全网同步失败，已先保存在本机。请稍后重试提交。");
      setMeta("本机已保存，云端同步失败。");
      return;
    }
    if (g && g.official) {
      setMeta("《" + payload.book + "》" + payload.name + " 已在角色池，已把征集分与原画像取平均。无需凑满 3 人。");
    } else if (g && g.inPool) {
      setMeta("《" + payload.book + "》" + payload.name + " 已满 " + THRESHOLD + " 人，已按平均分入测试池。所有人刷新可见。");
    } else {
      setMeta(
        "已同步 《" + payload.book + "》" + payload.name + "：" +
          (g ? g.count : 1) + "/" + THRESHOLD +
          "。其他人刷新页面即可看见。"
      );
    }
  }

  async function refresh() {
    setMeta("同步中…");
    await fetchCloud();
    await fetchCommunityJson();
    refreshGroups();
    renderList();
    setMeta(
      "已同步 · 征集 " + groupsCache.length + " 组 · 入池 " +
        getCommunityPoolRoles().length + " 个"
    );
    if (typeof global.renderHomeRoster === "function") global.renderHomeRoster();
  }

  function showSetup() {
    const hero = document.getElementById("hero");
    const setup = document.getElementById("setup");
    const cm = document.getElementById("community");
    const quiz = document.getElementById("quiz");
    const checkpoint = document.getElementById("checkpoint");
    const result = document.getElementById("result");
    if (cm) cm.classList.add("hidden");
    if (quiz) quiz.classList.add("hidden");
    if (checkpoint) checkpoint.classList.add("hidden");
    if (result) result.classList.add("hidden");
    if (hero) hero.classList.add("hidden");
    if (setup) setup.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function bindEnter() {
    const btn = document.getElementById("enterBtn");
    if (!btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      showSetup();
    });
  }

  function showCommunity() {
    ["hero", "setup", "quiz", "checkpoint", "result"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add("hidden");
    });
    const cm = document.getElementById("community");
    if (cm) cm.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
    renderList();
    refresh();
  }

  function hideCommunityToSetup() {
    const cm = document.getElementById("community");
    if (cm) cm.classList.add("hidden");
    const setup = document.getElementById("setup");
    if (setup) setup.classList.remove("hidden");
    else {
      const hero = document.getElementById("hero");
      if (hero) hero.classList.remove("hidden");
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function hideCommunityToHero() {
    const cm = document.getElementById("community");
    if (cm) cm.classList.add("hidden");
    const hero = document.getElementById("hero");
    if (hero) hero.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function initUi() {
    bindEnter();
    renderDimSliders();
    const localBtn = document.getElementById("c_submit_local");
    if (localBtn) localBtn.onclick = () => submitAndSync();
    refreshGroups();
    renderList();
    refresh();
  }

  function getGroups() {
    refreshGroups();
    return groupsCache.slice();
  }

  const Community = {
    THRESHOLD,
    getActiveRoles,
    getCommunityPoolRoles,
    getGroups,
    submitFromForm: () => submitFromForm(false),
    submitAndSync,
    refresh,
    showCommunity,
    hideCommunityToSetup,
    hideCommunityToHero,
    newVisitorId,
    initUi,
  };

  global.Community = Community;
  global.showSetup = showSetup;
  global.showCommunity = showCommunity;
  global.getActiveRoles = function () { return getActiveRoles(typeof roles !== "undefined" ? roles : []); };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initUi);
  } else {
    initUi();
  }
})(window);
