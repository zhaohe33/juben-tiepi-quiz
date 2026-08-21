/**
 * 角色征集：同一《剧本》+角色名，被 3 个不同访客提交后，
 * 对 12 维取平均并入测试池。
 */
(function () {
  const REPO = "zhaohe33/juben-tiepi-quiz";
  const THRESHOLD = 3;
  const STORAGE_KEY = "juben_community_submissions_v1";
  const VISITOR_KEY = "juben_community_visitor_v1";
  const ISSUE_PREFIX = "[角色提交]";

  const DIM_META = [
    ["agency", "行动欲"],
    ["empathy", "共情"],
    ["ambition", "野心"],
    ["loyalty", "羁绊"],
    ["control", "掌控"],
    ["sacrifice", "牺牲"],
    ["idealism", "理想"],
    ["vulnerability", "敏感"],
    ["autonomy", "自我"],
    ["moral", "灰度"],
    ["expression", "输出"],
    ["romance", "情爱"],
  ];

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
    let f = 0,
      m = 0;
    subs.forEach((s) => {
      if (s.gender === "female") f++;
      else m++;
    });
    return f >= m ? "female" : "male";
  }

  function pickText(subs, field) {
    const texts = subs.map((s) => (s[field] || "").trim()).filter(Boolean);
    if (!texts.length) return "";
    texts.sort((a, b) => b.length - a.length);
    return texts[0];
  }

  /** Merge local + remote submissions; one entry per (key, visitorId) — latest wins */
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
    groups.forEach((subs, k) => {
      // unique visitors
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
      const pooled = ready
        ? {
            book,
            name,
            gender: majorityGender(unique),
            v: averageVectors(unique.slice(0, THRESHOLD)),
            quote: pickText(unique, "quote") || "由玩家征集入池的角色。",
            why: pickText(unique, "why") || "三位玩家为同一角色提交了人格画像，系统取 12 维平均后入池。",
            risk: pickText(unique, "risk") || "征集角色仅供娱乐，请以店家官方说明为准。",
            community: true,
            votes: unique.length,
          }
        : null;

      out.push({
        key: k,
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

  let remoteSubmissions = [];
  let remotePool = [];
  let groupsCache = [];

  async function fetchCommunityJson() {
    try {
      const url = "community.json?t=" + Date.now();
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.submissions)) remoteSubmissions = data.submissions;
      if (Array.isArray(data.pool)) remotePool = data.pool;
    } catch (e) {
      /* static offline ok */
    }
  }

  async function fetchGithubIssues() {
    try {
      const url =
        "https://api.github.com/repos/" +
        REPO +
        "/issues?state=all&per_page=100&labels=character-submit";
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) {
        // fallback: no label filter
        const res2 = await fetch(
          "https://api.github.com/repos/" + REPO + "/issues?state=all&per_page=100",
          { headers: { Accept: "application/vnd.github+json" } }
        );
        if (!res2.ok) return;
        const issues = await res2.json();
        parseIssues(issues);
        return;
      }
      const issues = await res.json();
      parseIssues(issues);
    } catch (e) {
      /* rate limit / network */
    }
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
    if (parsed.length) {
      remoteSubmissions = mergeSubmissions(remoteSubmissions, parsed);
    }
  }

  function refreshGroups() {
    const all = mergeSubmissions(loadLocal(), remoteSubmissions);
    groupsCache = buildGroups(all);
    return groupsCache;
  }

  /** Roles approved into the quiz pool (averaged). */
  window.getCommunityPoolRoles = function getCommunityPoolRoles() {
    refreshGroups();
    const fromGroups = groupsCache.filter((g) => g.inPool && g.pooled).map((g) => g.pooled);
    // also include community.json pool entries not yet in groups
    const keys = new Set(fromGroups.map((r) => roleKey(r.book, r.name)));
    remotePool.forEach((r) => {
      if (!r || !r.book || !r.name) return;
      const k = roleKey(r.book, r.name);
      if (!keys.has(k)) {
        fromGroups.push({ ...r, community: true });
        keys.add(k);
      }
    });
    return fromGroups;
  };

  window.getActiveRoles = function getActiveRoles() {
    const base = typeof roles !== "undefined" ? roles : [];
    const extra = window.getCommunityPoolRoles();
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
  };

  function issueBody(payload) {
    return (
      "<!--JUBEN_CHAR\n" +
      JSON.stringify(payload) +
      "\n-->\n\n" +
      "### 角色征集\n" +
      "- 剧本：《" +
      payload.book +
      "》\n" +
      "- 角色：" +
      payload.name +
      "\n" +
      "- 性别：" +
      (payload.gender === "female" ? "女" : "男") +
      "\n" +
      "- 12维：" +
      payload.v.join(", ") +
      "\n\n" +
      "同一角色被 **3 位不同用户** 提交后，系统会取 12 维平均分自动入池。\n" +
      "\n请不要修改 `<!--JUBEN_CHAR ... -->` 代码块。\n"
    );
  }

  function openGithubIssue(payload) {
    const title = ISSUE_PREFIX + " 《" + payload.book + "》" + payload.name;
    const url =
      "https://github.com/" +
      REPO +
      "/issues/new?title=" +
      encodeURIComponent(title) +
      "&body=" +
      encodeURIComponent(issueBody(payload)) +
      "&labels=" +
      encodeURIComponent("character-submit");
    window.open(url, "_blank", "noopener");
  }

  function renderDimSliders(root) {
    root.innerHTML = DIM_META.map(([key, label], i) => {
      return (
        '<label class="dim-slider">' +
        "<span>" +
        label +
        '</span><input type="range" min="1" max="10" value="5" data-dim="' +
        i +
        '" /><b data-val="' +
        i +
        '">5</b></label>'
      );
    }).join("");
    root.querySelectorAll('input[type="range"]').forEach((inp) => {
      inp.addEventListener("input", () => {
        root.querySelector('[data-val="' + inp.dataset.dim + '"]').textContent = inp.value;
      });
    });
  }

  function readForm() {
    const book = document.getElementById("cBook").value.trim().replace(/^《|》$/g, "");
    const name = document.getElementById("cName").value.trim();
    const gender = document.getElementById("cGender").value;
    const quote = document.getElementById("cQuote").value.trim();
    const why = document.getElementById("cWhy").value.trim();
    const risk = document.getElementById("cRisk").value.trim();
    const v = [...document.querySelectorAll("#cDims input[type=range]")].map((el) =>
      clampInt(el.value)
    );
    return { book, name, gender, v, quote, why, risk };
  }

  function renderList() {
    const box = document.getElementById("cList");
    if (!box) return;
    const groups = refreshGroups();
    if (!groups.length) {
      box.innerHTML =
        '<p class="small" style="margin:0">还没有征集。提交同一角色满 3 人后，会按 12 维平均分入池。</p>';
      return;
    }
    box.innerHTML = groups
      .map((g) => {
        const pct = Math.min(100, Math.round((g.count / g.need) * 100));
        const status = g.inPool
          ? '<span class="c-badge on">已入池 · 取平均</span>'
          : '<span class="c-badge">征集中 ' + g.count + "/" + g.need + "</span>";
        const dims = g.inPool && g.pooled
          ? '<div class="c-avg">入池向量：[' + g.pooled.v.join(", ") + "]</div>"
          : "";
        return (
          '<div class="c-item">' +
          "<div class=\"c-item-top\"><b>《" +
          g.book +
          "》" +
          g.name +
          "</b>" +
          status +
          "</div>" +
          '<div class="c-bar"><i style="width:' +
          pct +
          '%"></i></div>' +
          dims +
          "</div>"
        );
      })
      .join("");
  }

  function setStatus(msg, ok) {
    const el = document.getElementById("cStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = ok ? "#c7a56b" : "#c9bdb4";
  }

  function submitCharacter(publishRemote) {
    const data = readForm();
    if (!data.book || !data.name) {
      setStatus("请填写剧本名和角色名。", false);
      return;
    }
    if (data.v.length !== 12) {
      setStatus("12 维分数不完整。", false);
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
      (s) => !(roleKey(s.book, s.name) === roleKey(payload.book, payload.name) && s.visitorId === payload.visitorId)
    );
    list.push(payload);
    saveLocal(list);
    refreshGroups();
    renderList();

    const g = groupsCache.find((x) => x.key === roleKey(payload.book, payload.name));
    if (g && g.inPool) {
      setStatus(
        "《" + payload.book + "》" + payload.name + " 已凑满 " + THRESHOLD + " 人，已按平均分入测试池！",
        true
      );
    } else {
      setStatus(
        "已记录。当前 《" +
          payload.book +
          "》" +
          payload.name +
          " 为 " +
          (g ? g.count : 1) +
          "/" +
          THRESHOLD +
          " 人。" +
          (publishRemote ? " 正在打开 GitHub 以便同步到全网…" : ""),
        true
      );
    }

    if (publishRemote) openGithubIssue(payload);
  }

  window.showCommunity = function showCommunity() {
    ["hero", "setup", "quiz", "checkpoint", "result"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add("hidden");
    });
    document.getElementById("community").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
    renderList();
    window.refreshCommunity && window.refreshCommunity();
  };

  window.hideCommunityToSetup = function hideCommunityToSetup() {
    document.getElementById("community").classList.add("hidden");
    document.getElementById("setup").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  window.refreshCommunity = async function refreshCommunity() {
    setStatus("同步征集板…", true);
    await fetchCommunityJson();
    await fetchGithubIssues();
    refreshGroups();
    renderList();
    const pooled = window.getCommunityPoolRoles().length;
    setStatus("已同步。入池征集角色 " + pooled + " 个。", true);
  };

  function init() {
    const dims = document.getElementById("cDims");
    if (dims) renderDimSliders(dims);

    const btnLocal = document.getElementById("cSubmitLocal");
    const btnRemote = document.getElementById("cSubmitRemote");
    const btnRefresh = document.getElementById("cRefresh");
    const btnNewId = document.getElementById("cNewVisitor");

    if (btnLocal) btnLocal.onclick = () => submitCharacter(false);
    if (btnRemote) btnRemote.onclick = () => submitCharacter(true);
    if (btnRefresh) btnRefresh.onclick = () => window.refreshCommunity();
    if (btnNewId)
      btnNewId.onclick = () => {
        newVisitorId();
        setStatus("已切换为新访客身份（用于本机模拟多人提交）。", true);
      };

    refreshGroups();
    renderList();
    fetchCommunityJson().then(() => {
      refreshGroups();
      renderList();
    });
    fetchGithubIssues().then(() => {
      refreshGroups();
      renderList();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
