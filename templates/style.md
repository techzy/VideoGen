# Style spec

Derived from the files in reference/. Anything uncertain is marked (?) for review.

## Pacing
- Average shot length: (?)
- Cuts per minute: (?)
- Punch-ins / zooms: (?)

## Captions
- Words per line: (?)
- Font, weight, case, size: (?)
- Position: (?)
- Highlight style: (?)
- Entry animation: (?)

## Transitions
- (?)

## Framing
- (?)

## Graphics
- Lower thirds, callouts, icons, progress bars: (?)

## Motion presets
One entry per animation in the brief's motion notes. Each name must exist in
composition/styles/motion.js (`vg build` checks).

| Preset | Kind | What it does | Easing | Duration | Direction | Seen in |
|---|---|---|---|---|---|---|
| slamUp | in | (?) | back.out(1.7) | 0.35 s | from below | (?) |

## Audio feel
- Music: (?)
- SFX on transitions: (?)

## Build settings

The block below is read by `vg build`. Keep it valid JSON.

```json vg-style
{
  "background": "#000000",
  "fonts": {},
  "captions": {
    "enabled": true,
    "maxWords": 3,
    "maxChars": 18,
    "case": "upper",
    "font": "Inter",
    "weight": 900,
    "size": "auto",
    "color": "#FFFFFF",
    "activeColor": "#FFD23F",
    "highlight": "color",
    "boxColor": "#FF5A36",
    "stroke": "#000000",
    "strokeWidth": 10,
    "position": "auto",
    "entry": "popIn",
    "exit": "cut",
    "skipFillers": true
  },
  "text": { "font": "Inter", "weight": 900, "color": "#FFFFFF", "accent": "#FF5A36", "accent2": "#FFD23F", "entry": "slamUp", "exit": "liftOut" },
  "broll": { "entry": "cut", "exit": "cut" },
  "cuts": { "framing": "none", "punchScale": 1.12 },
  "music": { "volume": 0.6, "duck": 0.3 }
}
```
