#!/usr/bin/env python3
"""Measure release startup, RSS and physical footprint including new WebKit XPC services.

Run in a disposable profile. Each launched process is terminated after its sample.
Run without other apps launching WebKit windows during the measurement: XPC attribution
uses the process delta (these services are parented by launchd, not the application).
"""
import argparse
import json
import os
import re
from pathlib import Path
import selectors
import statistics
import subprocess
import tempfile
import time


def snapshot():
    output = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss=,comm='], text=True)
    rows = []
    for line in output.splitlines():
        values = line.split(None, 3)
        if len(values) == 4:
            rows.append((int(values[0]), int(values[1]), int(values[2]), values[3]))
    return rows


def process_tree(pid, before):
    rows = snapshot()
    ids = {pid} | {p for p, _, _, name in rows if p not in before and '/com.apple.WebKit.' in name}
    while True:
        found = {p for p, parent, _, _ in rows if parent in ids}
        if found <= ids:
            break
        ids |= found
    return [{'pid': p, 'parent': parent, 'rss_kib': rss, 'name': name} for p, parent, rss, name in rows if p in ids]


def footprint(processes):
    command = ['footprint', '--noCategories', '-f', 'bytes']
    for p in processes:
        command.extend(['-p', str(p['pid'])])
    output = subprocess.check_output(command, text=True, stderr=subprocess.STDOUT, timeout=20)
    values = {int(pid): int(size) for pid, size in re.findall(r'\[(\d+)\]:[^\n]*Footprint: (\d+) B', output)}
    if len(values) != len(processes):
        raise RuntimeError('Incomplete physical footprint receipt: ' + output)
    return round(sum(values.values()) / 1024 / 1024, 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('binary', type=Path)
    parser.add_argument('--runs', type=int, default=5)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error('--runs must be positive')
    samples = []
    for run in range(args.runs):
        with tempfile.TemporaryDirectory(prefix='leaf-bench-') as profile:
            before = {p for p, _, _, _ in snapshot()}
            start = time.perf_counter()
            proc = subprocess.Popen([str(args.binary.resolve())], env={**os.environ, 'LEAF_DATA_DIR': profile, 'LEAF_BENCH': '1'}, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                selector = selectors.DefaultSelector()
                selector.register(proc.stdout, selectors.EVENT_READ)
                ready = False
                while time.perf_counter() - start < 30:
                    if selector.select(timeout=.2):
                        if proc.stdout.readline().strip() == b'LEAF_READY':
                            ready = True
                            break
                    if proc.poll() is not None:
                        break
                if not ready:
                    raise RuntimeError('No rendered readiness receipt within 30 seconds')
                elapsed = (time.perf_counter() - start) * 1000
                time.sleep(2)
                processes = process_tree(proc.pid, before)
                sample = {'run': run + 1, 'startup_ms': round(elapsed, 1), 'rss_mib': round(sum(p['rss_kib'] for p in processes) / 1024, 1), 'footprint_mib': footprint(processes), 'processes': processes}
                samples.append(sample)
                print(json.dumps(sample), flush=True)
            finally:
                selector.close()
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                # Wait for this app's XPC services to exit before the next baseline.
                for _ in range(20):
                    if not any(p not in before and '/com.apple.WebKit.' in name for p, _, _, name in snapshot()):
                        break
                    time.sleep(.1)
    result = {'binary_bytes': args.binary.stat().st_size, 'samples': samples, 'median_startup_ms': statistics.median(s['startup_ms'] for s in samples), 'median_rss_mib': statistics.median(s['rss_mib'] for s in samples), 'median_footprint_mib': statistics.median(s['footprint_mib'] for s in samples), 'notes': 'Warm OS caches after first launch; startup through two animation frames + IPC. Includes newly launched WebKit XPC services by process delta. RSS double-counts shared pages; footprint is the macOS physical footprint sum. No concurrent WebKit app launches during sampling. Not a full-system cold boot.'}
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'samples'}, indent=2))


if __name__ == '__main__':
    main()
