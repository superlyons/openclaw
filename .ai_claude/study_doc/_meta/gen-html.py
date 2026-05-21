#!/usr/bin/env python
"""
将 .ai_claude/study_doc/**/*.md 编译为 HTML 文档，放到 .ai_claude/study_doc_html/。

每个 mermaid 代码块：
  - 显示原始代码（<pre>）
  - 配 "🖼 查看图表" 按钮
  - 点击弹出 modal，渲染图表

用法：
  python .ai_claude/study_doc/_meta/gen-html.py

输出：
  .ai_claude/study_doc_html/  ← 浏览器打开里面的 index.html 或任何 .html 文件
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # project root
SRC_DIR = ROOT / ".ai_claude" / "study_doc"
OUT_DIR = ROOT / ".ai_claude" / "study_doc_html"


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>__TITLE__ | OpenClaw 学习文档</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5.5.1/github-markdown-light.min.css">
<style>
  :root {
    --sidebar-w: 280px;
    --accent: #0969da;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2328; background: #fff; }
  .layout { display: flex; min-height: 100vh; }
  .sidebar {
    width: var(--sidebar-w); flex-shrink: 0;
    border-right: 1px solid #d1d9e0; background: #f6f8fa;
    padding: 16px 12px; position: sticky; top: 0; height: 100vh; overflow-y: auto;
    font-size: 13px;
  }
  .sidebar h1 { font-size: 14px; margin: 0 0 12px; color: #57606a; text-transform: uppercase; letter-spacing: .04em; }
  .sidebar ul { list-style: none; padding: 0; margin: 0 0 16px; }
  .sidebar .group-title { font-size: 11px; color: #8c959f; text-transform: uppercase; margin: 12px 4px 4px; }
  .sidebar li { margin: 1px 0; }
  .sidebar a { color: #57606a; text-decoration: none; padding: 4px 8px; display: block; border-radius: 4px; }
  .sidebar a:hover { background: #eaeef2; color: #1f2328; }
  .sidebar li.active a { background: #ddf4ff; color: #0969da; font-weight: 600; }
  .content-wrap { flex: 1; min-width: 0; padding: 36px 48px 80px; }
  .markdown-body { max-width: 880px; margin: 0; box-sizing: border-box; }
  /* mermaid block */
  .mermaid-block {
    border: 1px solid #d1d9e0; border-radius: 6px; margin: 16px 0;
    background: #f6f8fa;
  }
  .mermaid-block .mermaid-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 12px; border-bottom: 1px solid #d1d9e0;
    background: #eaeef2;
    font-size: 12px; color: #57606a;
  }
  .mermaid-block .btn-view {
    background: var(--accent); color: white;
    border: none; padding: 4px 12px; border-radius: 4px;
    cursor: pointer; font-size: 12px;
  }
  .mermaid-block .btn-view:hover { background: #0860c4; }
  .mermaid-block pre {
    margin: 0; padding: 12px 14px; background: transparent;
    overflow-x: auto; font-size: 12px; line-height: 1.5;
  }
  /* (modal removed — viewer is in a new window via openMermaidWindow) */
  /* doc meta header */
  .doc-meta {
    background: #fff8c5; border-left: 4px solid #d4a72c;
    padding: 8px 14px; margin: 0 0 24px; font-size: 12px; color: #57606a;
    border-radius: 0 4px 4px 0;
  }
  .doc-meta code { background: rgba(175,184,193,.2); padding: 1px 4px; border-radius: 3px; }
  /* code blocks: use github style from markdown css */
  .markdown-body pre code { font-size: 12.5px; }
  .markdown-body table { display: table; }
  /* nav header */
  .topbar {
    border-bottom: 1px solid #d1d9e0; padding-bottom: 10px; margin-bottom: 20px;
    font-size: 12px; color: #57606a;
  }
  .topbar a { color: var(--accent); text-decoration: none; }
  .topbar a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <h1>OpenClaw 学习文档</h1>
    __SIDEBAR__
  </aside>
  <main class="content-wrap">
    <div class="topbar">
      📁 <code>__PATH__</code> · <a href="javascript:location.reload()">⟳ 刷新</a>
    </div>
    <article class="markdown-body" id="content"></article>
  </main>
</div>

<script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
<script>
  const RAW_MD = __MD_JSON__;

  // Custom renderer: convert mermaid fenced blocks to our custom HTML
  const renderer = new marked.Renderer();
  let mermaidIdx = 0;
  renderer.code = function(code, lang) {
    if (lang === "mermaid") {
      const idx = mermaidIdx++;
      const escaped = code.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      return `
        <div class="mermaid-block" data-mermaid-idx="${idx}">
          <div class="mermaid-header">
            <span>🖼 Mermaid 流程图 #${idx + 1}</span>
            <button class="btn-view" onclick="openMermaidWindow(${idx})">在新窗口查看图表 ↗</button>
          </div>
          <pre><code class="language-mermaid">${escaped}</code></pre>
        </div>`;
    }
    // default behavior
    const langClass = lang ? ` class="language-${lang}"` : "";
    const escaped = code.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    return `<pre><code${langClass}>${escaped}</code></pre>`;
  };

  // .md links -> .html links
  renderer.link = function(href, title, text) {
    let h = href;
    if (h && !/^[a-z]+:/i.test(h) && h.endsWith(".md")) {
      h = h.slice(0, -3) + ".html";
    }
    const t = title ? ` title="${title}"` : "";
    return `<a href="${h}"${t}>${text}</a>`;
  };

  marked.setOptions({ renderer, gfm: true, breaks: false });

  document.getElementById("content").innerHTML = marked.parse(RAW_MD);

  // Store mermaid sources for viewer
  const mermaidSources = [];
  document.querySelectorAll(".mermaid-block").forEach(block => {
    const idx = parseInt(block.dataset.mermaidIdx, 10);
    const codeEl = block.querySelector("code");
    mermaidSources[idx] = codeEl.textContent;
  });

  // Open mermaid diagram in a new window with zoom/pan
  window.openMermaidWindow = function(idx) {
    const src = mermaidSources[idx];
    const w = window.open("", "_blank", "width=1200,height=820");
    if (!w) {
      alert("浏览器阻止了新窗口弹出。请允许此页面打开新窗口。");
      return;
    }
    const docTitle = document.title.split(" | ")[0] || "Mermaid";
    w.document.write(VIEWER_HTML
      .replace("__MERMAID_SRC__", JSON.stringify(src))
      .replace("__TITLE__", `图 #${idx + 1} · ${docTitle}`));
    w.document.close();
  };

  // Viewer page (string) — opened in new window, self-contained
  const VIEWER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>__TITLE__</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; width: 100%; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #f6f8fa; }
  .toolbar {
    position: fixed; top: 0; left: 0; right: 0; height: 44px;
    background: rgba(255,255,255,0.95); border-bottom: 1px solid #d1d9e0;
    display: flex; align-items: center; padding: 0 16px; gap: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.04);
    z-index: 10; backdrop-filter: blur(8px);
    font-size: 13px;
  }
  .toolbar .title { font-weight: 600; color: #1f2328; margin-right: auto; }
  .toolbar button {
    background: #f6f8fa; border: 1px solid #d1d9e0; padding: 4px 10px;
    border-radius: 4px; cursor: pointer; font-size: 12px; color: #1f2328;
  }
  .toolbar button:hover { background: #eaeef2; }
  .toolbar .zoom-val { min-width: 56px; text-align: center; font-variant-numeric: tabular-nums; color: #57606a; }
  .toolbar .hint { color: #8c959f; font-size: 11px; margin-left: 8px; }
  .viewport {
    position: absolute; inset: 44px 0 0 0;
    overflow: hidden; cursor: grab; user-select: none;
    background: #fafbfc;
    background-image:
      linear-gradient(rgba(0,0,0,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,0,0,0.04) 1px, transparent 1px);
    background-size: 20px 20px;
  }
  .viewport.dragging { cursor: grabbing; }
  .diagram-wrap {
    position: absolute; left: 50%; top: 50%;
    transform-origin: 0 0;
    will-change: transform;
  }
  .diagram-wrap svg { display: block; max-width: none !important; max-height: none !important; height: auto !important; }
  .err { padding: 20px; color: #cf222e; font-family: monospace; white-space: pre-wrap; }
</style>
</head>
<body>
<div class="toolbar">
  <span class="title">__TITLE__</span>
  <button onclick="zoom(0.8)">−</button>
  <span class="zoom-val" id="zv">100%</span>
  <button onclick="zoom(1.25)">+</button>
  <button onclick="resetView()">重置</button>
  <button onclick="fitView()">适配</button>
  <span class="hint">滚轮缩放 · 拖拽移动 · +/-/0 快捷键</span>
</div>
<div class="viewport" id="viewport">
  <div class="diagram-wrap" id="wrap">渲染中...</div>
</div>

<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"><\/script>
<script>
  const SRC = __MERMAID_SRC__;
  mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose", maxTextSize: 100000 });

  const vp = document.getElementById("viewport");
  const wrap = document.getElementById("wrap");
  const zv = document.getElementById("zv");

  let scale = 1, panX = 0, panY = 0;
  const MIN_SCALE = 0.1, MAX_SCALE = 8;

  function update() {
    wrap.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + scale + ")";
    zv.textContent = Math.round(scale * 100) + "%";
  }

  function zoom(factor, cx, cy) {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    const realFactor = next / scale;
    if (cx === undefined) {
      // zoom centered on viewport center
      const rect = vp.getBoundingClientRect();
      cx = rect.width / 2; cy = rect.height / 2;
    }
    // keep point (cx,cy in viewport coords) fixed
    panX = cx - (cx - panX) * realFactor;
    panY = cy - (cy - panY) * realFactor;
    scale = next;
    update();
  }

  function resetView() { scale = 1; panX = vp.clientWidth / 2; panY = vp.clientHeight / 2; update(); }

  function fitView() {
    // Reset transform first to measure natural size
    const prev = wrap.style.transform;
    wrap.style.transform = "translate(-50%, -50%) scale(1)";
    const svg = wrap.querySelector("svg");
    if (!svg) { wrap.style.transform = prev; return; }
    const bb = svg.getBoundingClientRect();
    const vbb = vp.getBoundingClientRect();
    const fit = Math.min(vbb.width / bb.width, vbb.height / bb.height) * 0.9;
    scale = fit;
    panX = vp.clientWidth / 2;
    panY = vp.clientHeight / 2;
    update();
  }

  // Wheel zoom
  vp.addEventListener("wheel", e => {
    e.preventDefault();
    const rect = vp.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
    zoom(factor, cx, cy);
  }, { passive: false });

  // Drag pan
  let dragging = false, dragStartX = 0, dragStartY = 0;
  vp.addEventListener("mousedown", e => {
    dragging = true; vp.classList.add("dragging");
    dragStartX = e.clientX - panX; dragStartY = e.clientY - panY;
  });
  window.addEventListener("mousemove", e => {
    if (!dragging) return;
    panX = e.clientX - dragStartX; panY = e.clientY - dragStartY;
    update();
  });
  window.addEventListener("mouseup", () => { dragging = false; vp.classList.remove("dragging"); });

  // Keyboard
  window.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoom(1.25); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoom(0.8); }
    else if (e.key === "0") { e.preventDefault(); resetView(); }
    else if (e.key === "f" || e.key === "F") { e.preventDefault(); fitView(); }
  });

  // Render
  (async () => {
    try {
      const { svg } = await mermaid.render("m-" + Date.now(), SRC);
      wrap.innerHTML = svg;
      // Center on first render
      requestAnimationFrame(() => fitView());
    } catch (e) {
      wrap.innerHTML = '<div class="err">渲染失败：\\n' + (e.message || e) + '</div>';
    }
  })();
<\/script>
</body>
</html>`;
</script>
</body>
</html>
"""


def collect_md_files():
    """Return list of relative posix paths (str)."""
    files = []
    for p in sorted(SRC_DIR.rglob("*.md")):
        rel = p.relative_to(SRC_DIR).as_posix()
        files.append(rel)
    return files


def build_sidebar(current_rel_path, all_paths):
    """Build sidebar HTML, grouping by top-level directory."""
    # Group by top dir (or _root)
    groups = {}
    for p in all_paths:
        parts = p.split("/", 1)
        if len(parts) == 1:
            grp = "_root"
        else:
            grp = parts[0]
        groups.setdefault(grp, []).append(p)

    # Order: _root → 00-* → _meta → 10-* → 20-* → 30-*
    def grp_order(g):
        if g == "_root":
            return (0, g)
        if g == "_meta":
            return (1, g)
        return (2, g)

    cur_depth = current_rel_path.count("/")
    rel_prefix = "../" * cur_depth

    html_parts = []
    for grp in sorted(groups.keys(), key=grp_order):
        if grp != "_root":
            label = grp.replace("-", " ").upper() if grp == "_meta" else grp
            html_parts.append(f'<div class="group-title">{label}</div>')
        html_parts.append("<ul>")
        for p in sorted(groups[grp]):
            active = "active" if p == current_rel_path else ""
            html_path = p[:-3] + ".html"
            display = p.split("/")[-1].replace(".md", "")
            html_parts.append(
                f'<li class="{active}"><a href="{rel_prefix}{html_path}">{display}</a></li>'
            )
        html_parts.append("</ul>")
    return "\n".join(html_parts)


def render_html(md_relpath, md_text, all_paths):
    # Extract title from first heading line
    title = md_relpath
    for line in md_text.split("\n"):
        s = line.strip()
        if s.startswith("# "):
            title = s.lstrip("#").strip()
            break

    sidebar_html = build_sidebar(md_relpath, all_paths)
    md_json = json.dumps(md_text)  # safely escape for JS

    html = HTML_TEMPLATE
    html = html.replace("__TITLE__", title)
    html = html.replace("__SIDEBAR__", sidebar_html)
    html = html.replace("__PATH__", md_relpath)
    html = html.replace("__MD_JSON__", md_json)
    return html


def main():
    if not SRC_DIR.exists():
        print(f"源目录不存在: {SRC_DIR}", file=sys.stderr)
        sys.exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    all_paths = collect_md_files()

    if not all_paths:
        print(f"未找到 *.md: {SRC_DIR}", file=sys.stderr)
        sys.exit(1)

    count = 0
    for rel in all_paths:
        src_path = SRC_DIR / rel
        out_path = OUT_DIR / rel
        out_path = out_path.with_suffix(".html")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        md_text = src_path.read_text(encoding="utf-8")
        html = render_html(rel, md_text, all_paths)
        out_path.write_text(html, encoding="utf-8")
        print(f"  -> {out_path.relative_to(ROOT)}", file=sys.stderr)
        count += 1

    # Symlink/copy README.html as index.html for convenient entry
    readme_html = OUT_DIR / "README.html"
    index_html = OUT_DIR / "index.html"
    if readme_html.exists():
        index_html.write_text(readme_html.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"  -> {index_html.relative_to(ROOT)} (= README.html 副本)", file=sys.stderr)

    print(f"\n已生成 {count} 个 HTML 文件 → {OUT_DIR.relative_to(ROOT)}", file=sys.stderr)
    print(f"打开 {OUT_DIR.relative_to(ROOT)}/index.html 开始阅读", file=sys.stderr)


if __name__ == "__main__":
    main()
