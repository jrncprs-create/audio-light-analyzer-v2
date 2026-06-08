Audio Light Analyzer v2

A small, vanilla JS static app to inspect audio input signals and frequency energy over time.

Quick start (local):

- Open `index.html` in a browser (or use a local static server like `python -m http.server`).
- Allow microphone permission and select an input.

Features (v1):
- Input selector (microphone / BlackHole)
- Sample rate, RMS, peak, signal/no-signal
- Live waveform and spectrum
- Waveform history
- Energy timeline (low/mid/high)
- Frequency Rhythm Viewer (24 log bins, per-bin mini-history)
- Manual BPM input with simple 1-2-3-4 counter
- Debug panel and Reset Analysis button

No dependencies; static files only.
