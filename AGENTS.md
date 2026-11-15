# QRide agent instructions

Before changing any user-facing interface, CSS, interaction, animation, modal, or admin screen:

1. Read `DESIGN.md` in full. It is the project's UI source of truth.
2. Inspect the existing implementation and nearby states before editing.
3. Preserve the protected product decisions in `DESIGN.md`. Do not redesign approved screens or move elements outside the user's requested scope.
4. Apply only the Skills relevant to the concrete task. Do not add dependencies or introduce a new UI framework without a demonstrated need.
5. For motion, evaluate whether it is needed, honor reduced motion, and check interruption, performance, origin, and touch behavior.
6. Stress-test applicable edge cases: small screens, long/short/missing values, zero/large counts, empty lists, unusual characters, loading/error/disabled states.
7. Run the checks available in this repository. State clearly what was verified in code and what still needs a real-device/VK WebView check.
8. After repeated or explicitly confirmed design corrections, update `DESIGN.md` with the rule and its reason.

Keep diffs narrow. Do not mix visual changes with business logic, tariffs, database, or API behavior unless the user explicitly asks for those changes.
