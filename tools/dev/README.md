# Looking at the fire and measuring it (no Anvil needed)

`harness.html` runs the engine alone (three.js + `theme/assets/cf-*.js`); `look.py` serves it and drives headless
Chrome through `tools/live/drive.mjs`. Add `--gpu` to draw on this PC's graphics card (real frame rates, a screenshot
in seconds); without it Chrome uses the CPU rasteriser SwiftShader (about 3-10 frames a second, the same on every
machine, and a fair stand-in for a device limited by how many pixels it can fill).

    python -I tools/dev/look.py shots OUT --gpu [--place forest,snow,desert] [--q high] [--phone] [--warp 240]
        three frames of each place as PNGs: read them. --size 1200,675 = exact picture size (used for place-*.jpg)
    python -I tools/dev/look.py js tools/dev/metrics.js OUT --gpu --query "q=high"
        flame height / width, speed, and how far the flow is from mass-conserving, on a standard steady burner
    python -I tools/dev/look.py js tools/dev/bench.js OUT --gpu --uncap --query "q=low&uncap=1"
        frames a second with every cap off, draw calls, simulation passes     (drop --gpu --uncap for SwiftShader)
    python -I tools/dev/look.py js tools/dev/profile.js OUT --phone --query "q=lite&uncap=1"
        what each part of the picture costs (one part switched off at a time)
    python -I tools/dev/look.py js tools/dev/govern.js OUT --gpu --phone --query "q=auto&phase=gpu"   (or cpu, guess)
        the automatic quality governor under a faked slow graphics chip / capped frame rate
    python -I tools/dev/look.py js tools/dev/sound.js OUT --gpu
        every sound of every place played once; levels of the mix (nobody can listen in a test)
    python -I tools/dev/look.py run STEPS.json OUT --gpu --query "place=snow&q=medium"
        your own steps: [{"eval": "F.cam.tdist = 2"}, {"wait": 1500}, {"shot": "close"}]

Compare with an older engine: copy its `theme/assets/cf-*.js` + `three.min.js` into a folder (for instance
`git show <commit>:theme/assets/cf-fire.js > DIR/cf-fire.js`, one per file), then add `--old DIR --query "a=OLD&..."`.
In Git Bash a query that starts with a slash gets mangled, hence the `OLD` keyword.

In the page: `F` is the engine (`F.warp(sec)`, `F.state()`, `F.fire.setLook('uEdge', 0.2)`, `F.fire.setParams(fn)`),
`HARNESS_ERRORS` lists script errors. Freeze a moment to compare looks on the same flames: replace `F.fire.step`
with an empty function, change a uniform, shoot, change it back.

Numbers from 2026-11-11 (RTX 4070 laptop, 1264 x 705, caps off; standard burner):

| | old high | new high | old low | new low | new lite |
|---|---|---|---|---|---|
| frames a second | 504 | 585 (with 4x smoothing, 29% more cells) | 681 | 935 | 2552 |
| three.js draw calls a frame | 208 | 148 | 82 | 47 | 44 |
| ms a frame on SwiftShader, phone size | | | 310 | 188 | 107 |
| flame h50 / h90 / w80 (m) | .30 / .51 / .17 | .29 / .48 / .18 | .29 / .49 / .16 | .26 / .44 / .19 | .27 / .48 / .18 |
| large-scale divergence left (1/s) | 1.23 | 0.07 | 0.43 | 0.21 | 0.28 |
