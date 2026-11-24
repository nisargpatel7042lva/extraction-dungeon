# P4 Phase Report: Submission materials (Tue 24 Nov 2026)

## Written
- `README.md`: pitch, live links, how a run works, Mermaid architecture diagram (validated: valid flowchart), MagicBlock
  integration table, lessons learned (SDK feedback), latency numbers, repo map, run and test instructions, and what's not done.
- `docs/DEMO-SCRIPT.md`: a 2:30 shot list with voice-over, setup for two Phantom wallets, and fallbacks if VRF or the commit is slow.
- `docs/SUBMISSION.md`: name, a 95-char one-liner, description, how it uses MagicBlock, tests, feedback for MagicBlock,
  what's next. Placeholders left for: **repo URL, video URL, team**.

## Final verification on the shipped code
```
unit:      test result: ok. 6 passed; 0 failed
magicsvm:  test result: ok. 6 passed; 0 failed
client:    ✓ built in 16.87s
vercel:    Aliased https://extraction-dungeon-three.vercel.app · Ready in 20s
git audit: no keypairs / id.json / .env files would be added; dist/ now ignored
```

## Skipped
- **Private bags (PER), the stretch goal.** It needs a program upgrade, which needs ~1.67 SOL of temporary buffer; the CLI wallet has 0.38.

## Left for the user
1. A GitHub repo for judges (nothing is committed yet).
2. One Phantom playthrough on the live site (wallet signing has never been exercised), then record the video from `DEMO-SCRIPT.md`.
3. Log in to the submission form, fill it from `SUBMISSION.md`, and submit before Fri 27 Nov.
