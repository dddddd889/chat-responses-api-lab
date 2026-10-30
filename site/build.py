#!/usr/bin/env python3
# 从已提交的真实日志生成纯静态站点，不修改源日志，也不请求模型。
import hashlib
import json
import shutil
from pathlib import Path

SITE = Path(__file__).resolve().parent
SOURCE = SITE.parent / 'logs' / 'deepseek-live-three-layer-20261030-103715'
DIST = SITE / 'dist'
SCENES = {
    'text': ('文本与转义', '中文、emoji、引号与换行，如何从增量形成完整回答。', '01'),
    'json': ('结构化 JSON', 'JSON 正文仍以文本片段传输，完整之后才能解析。', '02'),
    'tool': ('单工具调用', '观察工具名称、调用 ID 和参数分别在哪条事件出现。', '03'),
    'multi_tool': ('双工具调用', '上海和北京两个工具独立累积参数，最后读取整次 usage。', '04'),
    'length': ('长度截断', '达到生成长度上限：区分传输完成与生成内容完整。', '05'),
    'thinking': ('思考模式', '观察推理内容与正文分别逐条累积，done 全文校准。', '06'),
    'http_error': ('HTTP 错误', '无效模型返回 HTTP 400：这是符合测试预期的拒绝。', '07'),
}

# 构建前校验输入，输出仅包含页面需要的真实日志和场景描述。
def build():
    summary = json.loads((SOURCE / 'live' / 'summary.json').read_text())
    assert len(summary) == 14 and all(item['status'] == 'passed' for item in summary)
    scenarios = []
    for entry in summary:
        kind = entry['name'].removeprefix(entry['protocol'] + '-')
        title, description, number = SCENES[kind]
        path = SOURCE / 'live' / entry['name'] / 'events.jsonl'
        text = path.read_text()
        records = [json.loads(line) for line in text.splitlines()]
        assert records and all(record['kind'] in ['sse', 'event', 'result', 'http_error'] for record in records)
        scenarios.append({'id': entry['name'], 'protocol': entry['protocol'], 'kind': kind, 'title': title, 'description': description, 'number': number, 'httpStatus': entry['http_status'], 'tokens': entry.get('total_tokens', 0), 'sourceText': text, 'sourceSHA256': hashlib.sha256(path.read_bytes()).hexdigest()})
    DIST.mkdir(exist_ok=True)
    (DIST / ".nojekyll").touch() # GitHub Pages 直接提供静态文件，不经过 Jekyll。
    for name in ['styles.css', 'core.js', 'usage.js', 'snapshot.js', 'journey-replay.js', 'journey.js', 'app.js', 'favicon.svg']:
        shutil.copyfile(SITE / 'web' / name, DIST / name)
    payload = {'model': 'deepseek-flash', 'date': '2026-10-30', 'totalTokens': sum(item['tokens'] for item in scenarios), 'source': str(SOURCE.relative_to(SITE.parent)), 'scenarios': scenarios}
    encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    (DIST / 'data.js').write_text('/* 已保存的真实调用日志，仅用于本地查看。 */\nwindow.SSE_DATA=' + encoded + ';\n')
    template = (SITE / 'web' / 'index.html').read_text()
    (DIST / 'index.html').write_text(template.replace('{{BASE}}', './').replace('{{SCENARIO}}', 'chat-multi_tool').replace('{{TITLE}}', 'SSE 流观察室'))
    for scene in scenarios:
        directory = DIST / 'scenarios' / scene['id']
        directory.mkdir(parents=True, exist_ok=True)
        html = template.replace('{{BASE}}', '../../').replace('{{SCENARIO}}', scene['id']).replace('{{TITLE}}', scene['title'] + ' · ' + scene['protocol'] + ' · SSE 流观察室')
        (directory / 'index.html').write_text(html)
    print(f'已生成 {len(scenarios)} 个独立场景页面：{DIST / "index.html"}')

if __name__ == '__main__':
    build()
