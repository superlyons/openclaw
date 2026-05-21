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
  /* modal */
  .modal-mask {
    position: fixed; inset: 0; background: rgba(0,0,0,.55);
    display: none; align-items: center; justify-content: center;
    z-index: 1000; padding: 20px;
  }
  .modal-mask.open { display: flex; }
  .modal-box {
    background: white; border-radius: 8px;
    max-width: 95vw; max-height: 92vh; overflow: auto;
    padding: 16px 20px; min-width: 320px;
    box-shadow: 0 10px 40px rgba(0,0,0,.3);
  }
  .modal-box .head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 12px; border-bottom: 1px solid #d1d9e0; padding-bottom: 8px;
  }
  .modal-box .head h3 { margin: 0; font-size: 14px; color: #57606a; }
  .modal-box .btn-close {
    background: none; border: none; font-size: 22px; cursor: pointer;
    color: #57606a; padding: 0 6px; line-height: 1;
  }
  .modal-box .btn-close:hover { color: #cf222e; }
  .modal-box .diagram { text-align: center; }
  .modal-box .diagram svg { max-width: 100%; height: auto; }
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

<div class="modal-mask" id="modal">
  <div class="modal-box">
    <div class="head">
      <h3 id="modal-title">流程图</h3>
      <button class="btn-close" onclick="closeModal()">×</button>
    </div>
    <div class="diagram" id="modal-diagram"></div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
<script>
  mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" });

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
            <button class="btn-view" onclick="viewMermaid(${idx})">查看图表</button>
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

  // Store mermaid sources for modal
  const mermaidSources = [];
  document.querySelectorAll(".mermaid-block").forEach(block => {
    const idx = parseInt(block.dataset.mermaidIdx, 10);
    const codeEl = block.querySelector("code");
    mermaidSources[idx] = codeEl.textContent;
  });

  window.viewMermaid = async function(idx) {
    const src = mermaidSources[idx];
    const modal = document.getElementById("modal");
    const dia = document.getElementById("modal-diagram");
    const title = document.getElementById("modal-title");
    title.textContent = `流程图 #${idx + 1}`;
    dia.innerHTML = "正在渲染...";
    modal.classList.add("open");
    try {
      const { svg } = await mermaid.render(`m-${Date.now()}-${idx}`, src);
      dia.innerHTML = svg;
    } catch (e) {
      dia.innerHTML = `<pre style="color:#cf222e">渲染失败：\n${e.message || e}</pre>`;
    }
  };

  window.closeModal = function() {
    document.getElementById("modal").classList.remove("open");
  };

  document.getElementById("modal").addEventListener("click", function(e) {
    if (e.target === this) closeModal();
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeModal();
  });
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
