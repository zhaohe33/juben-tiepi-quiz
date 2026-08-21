/**
 * 角色征集：同一《剧本》+角色名，被 3 个不同访客提交后，
 * 对 12 维取平均并自动入心测池。
 * 兼容 index.html 中的 Community.getActiveRoles(roles)
 */
(function (global) {
  const REPO = "zhaohe33/juben-tiepi-quiz";
  const THRESHOLD = 3;
  const STORAGE_KEY = "juben_community_submissions_v1";
  const VISITOR_KEY = "juben_community_visitor_v1";
  const ISSUE_PREFIX = "[角色提交]";

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

  function norm(s) {
    return String(s || "")
      .trim()
      .replace(/^《|》$/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function roleKey(book, name) {
    return norm(book) + "|" + norm(name);
  }

  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
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

  function pickText(subs, field, fallback) {
    const texts = subs.map((s) => (s[field] || "").trim()).filter(Boolean);
    if (!texts.length) return fallback || "";
    texts.sort((a, b) => b.length - a.length);
    return texts[0];
  }

  function mergeSubmissions(localList, remoteList) {
    const map = new Map();
    [...remoteList, ...localList].forEach((s) => {
      if (!s || !s.book || !s.name || !Array.isArray(s.v) || s.v.length !== 12) return;
      const k = roleKey(s.book, s.name) + "::" + (s.visitorId || s.user || "");
      const prev = map.get(k);
      if (!prev || (s.at || "") > (prev.at || "")) map.set(k, s);
    });
    return [...map.values()];
  }

  function buildGroups(submissions) {
    const groups = new Map();
    submissions.forEach((s) => {
      const k = roleKey(s.book, s.name);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    });

    const out = [];
    groups.forEach((subs) => {
      const byVisitor = new Map();
      subs.forEach((s) => {
        const vid = s.visitorId || s.user || uid();
        const prev = byVisitor.get(vid);
        if (!prev || (s.at || "") > (prev.at || "")) byVisitor.set(vid, s);
      });
      const unique = [...byVisitor.values()];
      const book = unique[0].book.replace(/^《|》$/g, "").trim();
      const name = unique[0].name.trim();
      const ready = unique.length >= THRESHOLD;
      const take = unique.slice(0, Math.max(THRESHOLD, unique.length));
      const forAvg = unique.slice(0, THRESHOLD);
      const pooled = ready
        ? {
            book,
            name,
            gender: majorityGender(forAvg),
            v: averageVectors(forAvg),
            quote: pickText(forAvg, "quote", "由玩家征集入池的角色。"),
            why: pickText(forAvg, "why", "三位玩家为同一角色提交了人格画像，系统取 12 维平均后入池。"),
            risk: pickText(forAvg, "risk", "征集角色仅供娱乐，请以店家官方说明为准。"),
            community: true,
            votes: unique.length,
          }
        : null;

      out.push({
        key: roleKey(book, name),
        book,
        name,
        count: unique.length,
        need: THRESHOLD,
        inPool: ready,
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
      if (Array.isArray(data.submissions)) remoteSubmissions = data.submissions;
      if (Array.isArray(data.pool)) remotePool = data.pool;
    } catch (e) {}
  }

  function parseIssues(issues) {
    if (!Array.isArray(issues)) return;
    const parsed = [];
    issues.forEach((issue) => {
      if (!issue.title || issue.title.indexOf(ISSUE_PREFIX) !== 0) return;
      if (issue.pull_request) return;
      const m = /<!--JUBEN_CHAR\s*([\s\S]*?)-->/.exec(issue.body || "");
      if (!m) return;
      try {
        const obj = JSON.parse(m[1].trim());
        obj.user = (issue.user && issue.user.login) || "github";
        obj.visitorId = "gh:" + obj.user;
        obj.at = issue.created_at || obj.at || "";
        parsed.push(obj);
      } catch (e) {}
    });
    if (parsed.length) remoteSubmissions = mergeSubmissions(remoteSubmissions, parsed);
  }

  async function fetchGithubIssues() {
    try {
      const res = await fetch(
        "https://api.github.com/repos/" + REPO + "/issues?state=all&per_page=100",
        { headers: { Accept: "application/vnd.github+json" } }
      );
      if (!res.ok) return;
      parseIssues(await res.json());
    } catch (e) {}
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
    const seen = new Set(base.map((r) => roleKey(r.book, r.name)));
    const merged = base.slice();
    extra.forEach((r) => {
      const k = roleKey(r.book, r.name);
      if (seen.has(k)) return;
      seen.add(k);
      if (typeof R === "function") {
        merged.push(R(r.book, r.name, r.gender, r.v, r.quote, r.why, r.risk));
      } else {
        merged.push(r);
      }
    });
    return merged;
  }

  function issueBody(payload) {
    return (
      "<!--JUBEN_CHAR\n" +
      JSON.stringify(payload) +
      "\n-->\n\n" +
      "### 角色征集\n" +
      "- 剧本：《" + payload.book + "》\n" +
      "- 角色：" + payload.name + "\n" +
      "- 性别：" + (payload.gender === "female" ? "女" : "男") + "\n" +
      "- 12维：" + payload.v.join(", ") + "\n\n" +
      "同一角色被 **3 位不同用户** 提交后，系统取 12 维平均分自动入池。\n" +
      "请勿修改 `<!--JUBEN_CHAR ... -->` 代码块。\n"
    );
  }

  function openGithubIssue(payload) {
    const title = ISSUE_PREFIX + " 《" + payload.book + "》" + payload.name;
    const url =
      "https://github.com/" + REPO + "/issues/new?title=" +
      encodeURIComponent(title) +
      "&body=" + encodeURIComponent(issueBody(payload)) +
      "&labels=" + encodeURIComponent("character-submit");
    window.open(url, "_blank", "noopener");
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
    const quote = ((quoteEl && quoteEl.value) || "").trim();
    const why = "";
    const risk = "";
    const v = [...document.querySelectorAll("#c_dims input[type=range]")].map((el) =>
      clampInt(el.value)
    );
    return { book, name, gender, v, quote, why, risk };
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
        const status = g.inPool
          ? '<span class="c-tag">已入池 · 平均向量</span>'
          : '<span class="c-sub">征集中 ' + g.count + "/" + g.need + "</span>";
        const avg =
          g.inPool && g.pooled
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
      return;
    }
    if (data.v.length !== 12) {
      setError("请完整拖动 12 维分数。");
      return;
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

    const g = groupsCache.find((x) => x.key === roleKey(payload.book, payload.name));
    if (g && g.inPool) {
      setMeta("《" + payload.book + "》" + payload.name + " 已满 " + THRESHOLD + " 人，已按平均分入测试池。");
    } else {
      setMeta(
        "已记录 《" + payload.book + "》" + payload.name + "：" +
          (g ? g.count : 1) + "/" + THRESHOLD + " 人。"
      );
    }

    if (publishRemote) {
      openGithubIssue(payload);
      setMeta(
        (g && g.inPool
          ? "《" + payload.book + "》" + payload.name + " 已入池。"
          : "已记录 《" + payload.book + "》" + payload.name + "：" + (g ? g.count : 1) + "/" + THRESHOLD + "。") +
          " 已打开 GitHub：登录后点 Create issue，其他人刷新即可看见。"
      );
    }
    return payload;
  }

  function submitAndSync() {
    submitFromForm(true);
  }

  async function refresh() {
    setMeta("同步中…");
    await fetchCommunityJson();
    await fetchGithubIssues();
    refreshGroups();
    renderList();
    setMeta(
      "已同步 · 征集 " + groupsCache.length + " 组 · 入池 " +
        getCommunityPoolRoles().length + " 个"
    );
    if (typeof global.renderHomeRoster === "function") global.renderHomeRoster();
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
  global.showCommunity = showCommunity;
  global.getActiveRoles = function () { return getActiveRoles(typeof roles !== "undefined" ? roles : []); };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initUi);
  } else {
    initUi();
  }
})(window);
