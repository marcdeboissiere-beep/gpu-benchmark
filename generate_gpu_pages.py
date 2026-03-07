#!/usr/bin/env python3
"""Generate individual GPU benchmark pages from benchmark_data.json"""
import json
import os
import shutil
from pathlib import Path

TEMPLATE_FILE = Path(__file__).parent / 'gpu-template.html'
OUTPUT_DIR = Path(__file__).parent / 'gpu'
DATA_FILE = Path(__file__).parent / 'data' / 'benchmark_data.json'

GPU_SLUG = {
    'RTX 5090': 'rtx-5090', 'RTX 5080': 'rtx-5080', 'RTX 5070 Ti': 'rtx-5070-ti',
    'RTX 5070': 'rtx-5070', 'RTX 4090': 'rtx-4090', 'RTX 4080 Super': 'rtx-4080-super',
    'RTX 4080': 'rtx-4080', 'RTX 4070 Ti': 'rtx-4070-ti', 'RTX 4070 Ti Super': 'rtx-4070-ti-super',
    'RTX 4070 Super': 'rtx-4070-super', 'RTX 4070': 'rtx-4070',
    'RTX 4060 Ti 16GB': 'rtx-4060-ti-16gb', 'RTX 4060 Ti': 'rtx-4060-ti',
    'RTX 4060': 'rtx-4060', 'RTX 3090': 'rtx-3090', 'RTX 3080': 'rtx-3080',
    'RTX 3070': 'rtx-3070', 'RTX 3060': 'rtx-3060',
    'RX 9070 XT': 'rx-9070-xt', 'RX 7900 XTX': 'rx-7900-xtx',
    'Arc B580': 'arc-b580'
}

def generate_gpu_pages():
    with open(DATA_FILE) as f:
        data = json.load(f)

    template = TEMPLATE_FILE.read_text(encoding='utf-8')
    OUTPUT_DIR.mkdir(exist_ok=True)

    raw_gpus = data.get('gpus', [])
    if isinstance(raw_gpus, list):
        # Array-of-objects structure: [{"name": "RTX 4090", ...}, ...]
        gpus = [g['name'] for g in raw_gpus if 'name' in g]
    elif isinstance(raw_gpus, dict):
        # Dict structure: {"RTX 4090": {...}, ...}
        gpus = list(raw_gpus.keys())
    else:
        # Fallback: look for GPU names as top-level keys
        gpus = [k for k in data.keys() if k not in ['generated_at', 'metadata', 'models']]

    generated = []
    for gpu_name in gpus:
        slug = GPU_SLUG.get(gpu_name, gpu_name.lower().replace(' ', '-'))
        output_file = OUTPUT_DIR / f'{slug}.html'

        # Customize template for this GPU
        page_content = template.replace(
            'RTX 4090 Ollama Benchmark \u2014 Tokens Per Second | LLM Speed Test',
            f'{gpu_name} Ollama Benchmark \u2014 Tokens Per Second | LLM Speed Test'
        ).replace(
            'NVIDIA RTX 4090 &mdash; LLM Inference Speed',
            f'{gpu_name} &mdash; LLM Inference Speed'
        ).replace(
            "textContent = 'RTX 4090'",
            f"textContent = '{gpu_name}'"
        ).replace(
            'GPU_PAGE_CONFIG = {\n    gpuName: document.getElementById(\'nav-gpu-name\').textContent,',
            f'GPU_PAGE_CONFIG = {{\n    gpuName: "{gpu_name}",'
        )

        output_file.write_text(page_content, encoding='utf-8')
        generated.append(slug)
        print(f'Generated: gpu/{slug}.html')

    print(f'\nGenerated {len(generated)} GPU pages: {", ".join(generated)}')

if __name__ == '__main__':
    generate_gpu_pages()
