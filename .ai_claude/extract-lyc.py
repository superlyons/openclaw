#!/usr/bin/env python3
"""
为单个文件：基于 v2026.5.18 的官方代码，注入仅 lyc 注释行（来自 backup 分支）。
策略：用 git diff 输出，逐 hunk 处理，删除/保留每个 + 行。
"""
import subprocess
import sys
import re
import os

BASE = "v2026.5.18"
BACKUP = "study-base-v2026.5.18-attempt1"

LYC_PATTERN = re.compile(r'lyc[: ]', re.IGNORECASE)


def is_lyc_line(line):
    """判断一个 + 行是否是 lyc 注释或注释延续。"""
    s = line.lstrip('+').strip()
    if not s:
        return True  # 空行允许
    # 行内含 lyc:
    if 'lyc:' in s.lower() or 'lyc ' in s.lower():
        return True
    # 多行注释延续：以 * 开头，或在 /* */ 块内的常见模式
    if s.startswith('*') or s.startswith('//') or s.startswith('#'):
        return True
    # 闭合 */
    if s == '*/' or s.endswith('*/'):
        return True
    return False


def filter_file(file_path):
    """获取从 v2026.5.18 到 backup 的 diff，过滤后应用到 v2026.5.18 上。"""
    # 获取 v2026.5.18 版本
    base_content = subprocess.run(
        ["git", "show", f"{BASE}:{file_path}"],
        capture_output=True, text=True, encoding='utf-8', errors='replace'
    ).stdout

    if not base_content:
        return None  # 文件在 v2026.5.18 中不存在（如 .ai_claude/*）

    # 获取 backup 版本
    backup_content = subprocess.run(
        ["git", "show", f"{BACKUP}:{file_path}"],
        capture_output=True, text=True, encoding='utf-8', errors='replace'
    ).stdout

    if not backup_content:
        return base_content  # backup 中已删除，留 base

    base_lines = base_content.splitlines(keepends=True)
    backup_lines = backup_content.splitlines(keepends=True)

    # 用 difflib 算最长公共子序列
    import difflib
    matcher = difflib.SequenceMatcher(None, base_lines, backup_lines, autojunk=False)

    result = []
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op == 'equal':
            result.extend(base_lines[i1:i2])
        elif op == 'insert':
            # backup 在此处插入了新行；只保留 lyc 注释
            for line in backup_lines[j1:j2]:
                if is_lyc_line('+' + line):
                    result.append(line)
        elif op == 'delete':
            # backup 删除了 base 中的行——保留 base 的
            result.extend(base_lines[i1:i2])
        elif op == 'replace':
            # backup 修改了行——保留 base 的，但抓出 backup 块里的 lyc 注释插到前面
            for line in backup_lines[j1:j2]:
                if is_lyc_line('+' + line):
                    result.append(line)
            result.extend(base_lines[i1:i2])

    return ''.join(result)


def main():
    if len(sys.argv) < 2:
        print("Usage: extract-lyc.py <file> [<file>...]", file=sys.stderr)
        sys.exit(1)

    for file_path in sys.argv[1:]:
        merged = filter_file(file_path)
        if merged is None:
            print(f"SKIP (not in base): {file_path}", file=sys.stderr)
            continue
        with open(file_path, 'w', encoding='utf-8', newline='') as f:
            f.write(merged)
        print(f"OK: {file_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
