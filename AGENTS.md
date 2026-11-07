# Prototype Instructions

## Autonomous operations · candidate protocolVersion 3 · 2026-10-29

Task progress, deliverable acceptance, mathematical objective completion and run
termination are distinct. `save_progress` creates no acceptance Agent. Submitting
a partial report does not close a proof objective or automatically repeat the same
task. Agents choose decomposition, tools, branches, rework and whether to continue
their current task (`afterAcceptance: continue`). The coordinator receives the
remaining objectives and chooses the next action; no fixed proof sequence, repair
count or paper-specific route is introduced.

Tools have durable client operation IDs. Start once, query the same ID or yield
while work continues independently of the CLI/HTTP connection. Preserve unknown
outcomes without replay; a transport timeout is not a mathematical failure. Do not
commit submission/acceptance while the same actor's work is outstanding. Preserve
late target receipts and their original versions; never overwrite a revised goal.

Native proof success requires a structured audit of the exact Lean declaration,
allowed axioms, target/proof identity and complete requested dependency audit.
Large dependency output goes to its own evidence file. Same-run independent proof
reuse is explicit, checks exact contract/proof/mode and current content-addressed
environment, and remains a reuse receipt rather than a new native check. Source
fidelity and route assessment remain separate. Revised targets/environments require
new checks. Paginated board/evidence views preserve full immutable saved content.
Source offset handles preserve exact extracted text; never guess mathematical
symbols. Resource management stays separate from role orchestration.

For real-paper evaluations preserve the frozen version. Candidate controlled tests
and browser fixtures do not establish autonomous mathematical success. Do not
mutate active evaluations or silently restart them to deploy these repairs.

## Three-role autonomous team · 2026-10-29 (current mathematics entry)

The user authorized a full redesign with exactly three identities: main Agent,
freely created task Agents, and an automatically created independent acceptance
Agent for every major submission. The mathematics UI uses the team-v1 entry.
The execution adapter is local Codex CLI, gpt-6-sol, reasoning effort high.
Do not silently substitute a model or use the old gateway for this entry.

Remove fixed mathematical phase gates and per-role exploration tool restrictions.
Tasks may inspect sources/libraries, create target versions, decompose, cooperate,
check, and repair in their own order. No mandatory human semantic signature.
Submitted artifacts and old target versions stay immutable. Acceptance can return
rework; the owner continues a new version. Independent model acceptance does not
replace a native Lean check, establish semantic equivalence, or certify an author
route. All outstanding premises and unverified scope stay explicit.

Keep role/task orchestration in server/team, CLI/transport adapters in
server/adapters, and capacity/admission in server/resources. Resources must not
encode mathematical stages. Source/paper-specific scripts and supplied proof
answers are forbidden in autonomous acceptance. Use raw PDF and an empty review
store. Earlier stage-specific instructions below describe the legacy engine and
must not reintroduce fixed stages into team-v1. Existing immutable historical
records retain their original engine and acceptance meanings. Retain native
evidence audits, isolated execution, source identities and unknown-outcome
preservation. Knowledge-base synchronization remains deferred.

On 2026-10-29 the user explicitly authorized restarting local Codex CLI sessions
after the specific "Selected model is at capacity" response. Preserve the failed
turn and received artifacts, then restart only the unfinished actor with the
current durable board. Do not resubmit completed task transitions, reset the
review, change the requested model, or apply this exception to unrelated unknown
errors. Resource-layer backoff and the shared run budget remain applicable.

## Durable proof continuation · 2026-10-29

For team-v1 protocolVersion 2, report acceptance, source-grounded objective
completion, and the decision to stop are distinct. An accepted partial report
must not close unresolved proof objectives or an empty queue end a review.
Agents maintain versioned objectives and dependencies, choose tools and task
boundaries freely, and may submit progress while continuing. Stopping incomplete
requires actual attempt receipts and independent assessment of remaining work;
there is no fixed search count, repair depth or mathematical phase sequence.
Persistent Lean workspaces, forks/merges, native diagnostic builds, type-aware
paginated premise search, nested lemma projects and root assembly are available
through the same team tool bridge. Diagnostic builds, conditional helpers,
exact target proofs, source assessments and original-route assessments remain
separate. Resource admission remains a separate module. Invalidation of a target
or dependency invalidates dependent objective acceptance. Unknown external
outcomes remain archived; only the specifically authorized capacity rejection
can restart automatically. A real-paper run receives only the raw PDF and generic
intent, with fresh storage, no prior proof cache and no human mathematical help.

## Computer-science track · 2026-10-22

The user chose an upfront door: mathematics or computer science. The door selects the checker family and the wording of conclusions. It does not freeze every claim into one prover. Mathematics keeps the existing full-text Lean review. A computer-science review must not enter Mathlib formalization automatically. The model may only propose claim candidates. Each candidate is a verbatim sentence from the extracted text, and the person chooses its kind. A candidate is not a check result. Checkers run only after a person submits that sentence with code, an artifact, or a proof. Unknown model outcomes are archived once and are not retried automatically. Classify each claim. A numeric comparison runs only when code and one or more expected outputs are present, each expected text occurs once in the extracted paper, and any extra files stay inside the archived `python3 experiment.py` command. Tolerance applies only to numeric comparison. A mismatch stays a mismatch. Call Lean only for a target in the four accepted library profiles, with the quote located in the extracted text. Prose sentences and Rocq correspondence sentences use the same unique-location rule; otherwise the claim stays source_unlocated and the checker does not run. Prose proofs, missing artifacts, unwired provers, and GPU, cluster, or exploit claims stay explicit non-results. A matching sandbox output is not a theorem certificate. A Lean check certifies that one target only. Rocq 9.3.0 from the Homebrew bottle 034125ee4c09f42e6a3a25b04fd86b5f26898be6cc36523d6203590f90428708 is the only wired foreign prover: `make check` replays the proof and `make validate` lists axioms and admits. Those three columns stay separate. An admit or an extra axiom is recorded and is not proof completion. Isabelle, F*, EasyCrypt, Agda, and Dafny stay unwired. TLA+ tools 1.7.4, jar sha256 936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88, is the bounded checker: `make check` runs one TLC simulation of the recorded depth and `make bound` records that other behaviors and deeper states were not checked. A finished simulation or a behavior found inside the bound is not proof completion. The paper record stays `theorem: unknown` and `reviewComplete: false`. The math replay entry continues to reject computer-science records. Computer-science replay re-runs archived sandbox code, archived Lean proofs, and archived Rocq sources with the pinned prover. It accepts no new expected output, source, or proof, does not call the model, and writes a new root. A different result keeps both roots. Switching doors creates a new review and leaves the other track's evidence unchanged.

## Generic review closure · 2026-10-20

Keep a short source locator separate from the full proposition spans. Before autonomous formalization, the Agent selects complete source-grounded premises and conclusions, receives an independent completeness assessment, and binds both immutable receipts into the child context and replay. Expansion preserves the source proposition; it is not permission to change a fixed formal target or correct the author's mathematics. Do not add paper names, theorem numbers, source hashes or supplied proof answers as product branches.

The first reading stage returns a short unique verbatim locator, not a retyped complete formula. Never normalize PDF control characters into guessed mathematical symbols. Reading-anchor failures retain the exact rejected locator, page and source identity for Agent repair. Repeated-failure identity follows the actual locator and compiler/source error, not a renamed label; a genuinely changed locator may be rechecked within the existing bounded retries. A successful locator does not bypass the independent full-proposition scope stage.

Translation, dependency planning and finite experiments must have actual execution tools before a proof contract exists. Diagnostic draft typing may use an explicitly labelled probe; it must never produce a paper proof certificate. Finite experiments retain executed code and output, run offline in an isolated directory with time/output/process/memory limits, and remain distinct from mathematical proof. A computation that was not run cannot be marked a successful numerical check. External dependencies cross stages only through this stage's reachable immutable installation receipts and fresh native checks.

Recovery fingerprints use actual source spans, mathematical target, imported/compiled environment and diagnostics, not task ids or new prose labels. Repeated deterministic failures with unchanged corrective inputs stop that branch. Changed source/targets/environments may permit a fresh version; unknown external model outcomes never replay automatically. Unwrap SDK middleware exceptions so the original model receipt and unknown-outcome status survive. A conjunction interface is not a solved helper or source proof.

Cancellation must wait for owned workers and children to settle, preserve all attempts, archive absent outputs as null, and leave no running task labels after the process exits. SDK cancellation can finish before transport and tool callbacks: close future dispatches and drain actual model/onRecord and tool promises before sealing any harness root. Bind settled child roots only after checking parent task and paper identities, including cancellation from a paused state. Freeze the implementation for real-paper evaluations, use fresh stores without historical proofs, record any explicit test budgets separately from product defaults, and report scope repair, actual tools, kernel certificates, original-route coverage and generalization limits separately. The stopped run c9753220-02d7-4aea-bc08-806e252bbd13 remains historical evidence and must not be resumed or rewritten.

## Autonomous proof acceptance · 2026-10-20

The user rejected source-specific construction scripts and prewritten proof candidates as evidence of general proving ability. New model review sessions must use fresh Agent-only proof scopes. Do not import developer-generated proof memory, prior paper proof graphs or theorem certificates into a fresh acceptance run. Raw PDF and a natural-language scope are sufficient inputs; the product Agents must choose the formalization, split obligations, construct helpers and repair failures. Same-session checkpoints may be reused with their actual origin preserved. Use a generic raw-PDF runner and separate empty stores for the known paper and a new holdout; freeze inputs and implementation hashes, retain unsuccessful attempts, and report source fidelity, local Lean checks, full assembly and autonomy separately. Scripted provider tests validate tool plumbing only. Development-time proofs or individual examples cannot establish autonomous success or general coverage.

Translation recovery must distinguish source-anchor-only repairs from revising a formal target. Native syntax/type failures and semantic findings can trigger a new target version from the exact same selected source. Never mutate the old contract or inherit its approval, proof acceptance, original route or search result into a revised target. Preserve the domain/environment identity, rerun native typing and independent semantic review, and let the Agent decide again. Rechecking an unchanged invalid target is not translation repair.

Long tool conversations must compact public working history before transport, retaining the exact task, current target/environment and immutable tool receipts. Summaries are navigation, never proof evidence or authority to change a target. Summary calls use the same application transport, budget, cancellation and receipts; provider-private reasoning must not enter public summaries or exports. A local pre-dispatch context guard is not an unknown external outcome. A complete final JSON object may be extracted from one unambiguous Markdown JSON fence, preserving raw/extracted/normalized hashes and all mathematical strings; never choose between multiple objects or infer missing fields. Redundant trailing object closers after a complete object may be normalized with provenance. Truncated responses and tool arguments remain strict.

Environment selection must update the workspace goal and current contract as well as the compiler and final certificate. Diagnostic commands use only verified compiled library roots and remain offline, isolated and non-certifying. Successful and failed model tasks must link their actual Deep Agents receipt roots into exported evidence.

Agents must be able to read the locally pinned Mathlib source without inspecting GitHub first. Read immutable Git objects, expose bounded line windows with full-source and excerpt hashes, and reject file paths. Explicitly distinguish source inspection from imports, compatible installation and proof acceptance. External source reads require an inspected immutable commit, bounded download and valid UTF-8. Do not silently serve default-version Mathlib as the source of a different sealed environment. Prepared source checkpoints must accept the exact task: and original: interface-stage receipt types used by the two product adapters, while retaining graph, source, contract and session identity checks.

The SDK filesystem and offline shell must refer to the same isolated workspace even when the model copies its physical current-directory path. Keep traversal/symlink protection and deny other host paths. Goal/task metadata and compiled Goal modules are reserved: source translation changes use a new source-grounded target version, never filesystem edits. prepare_goal compiles only the fixed proposition's signature, including False, and cannot create a proof certificate. Invalidate compiled Goal objects when the contract/environment changes. add_mathlib_modules may prepare and import immutable pinned modules while preserving exact target text, metadata, existing module identities, definitions and proved lemmas. Its structural scope check is not a proof of natural-language equivalence. Native local/root checks and independent route assessment remain mandatory. Shell probes and goal preparation share the native Lean resource pool and library leases; final proofs cannot depend on scratch/Goal modules.

Same-session source continuations create new records with unchanged mathematical inputs, preserve all failed attempts and unknown outcomes, and are not new fresh samples. Generic offline continuation must reject unfinished/live stores before startup crash recovery. A checkpoint fork copies immutable received artifacts and same-session proof-memory indexes only; it cannot manufacture a completed paper review or import developer proofs. Version changes, additional budget segments and the original incomplete result must be reported separately.

## Deep Agents execution harness · 2026-10-19

Restore a recovered candidate's compatible import/environment contract after candidate selection, before its native check. Keep the exact source, target, definitions, assumptions and metadata under the same-mathematics guard; never restore an unrelated old target merely because its displayed formula is similar. A term compiled with additional pinned modules must not be checked under the baseline imports by accident. Validate this path with a native candidate whose compilation actually needs the added module, not only with a term that would also compile in the base profile.

Do not lose already received native-checked candidates when a worker's final JSON/route metadata fails or its budget expires. Retain all execution receipt roots in completed and interrupted source reports. Recovery may inspect immutable completed worker receipts only when the owning source review, formal root and Agent session match; exclude foreign sessions, changed definitions/metadata and unknown worker outcomes. Recover candidate text, never old policy acceptance. Every recovered term requires a new native check and independent source-route assessment. Export the new recovery provenance without rewriting old roots. Evaluation-specific model-call limits must be explicit, bounded by the shared runtime ceiling, archived with inputs and distinct from product defaults.

Reviewer-generated method policies require a separate, scoped independent Agent audit when Lean command words were put into declaration-name families. Preserve every explicit declaration, axiom and genuine method restriction, and retain the raw graph/review. Only ambiguous command-family items may be classified as existing kernel rules or replaced by precise source-anchored method restrictions. This Agent decision is neither a kernel certificate nor a human attestation. Unresolved policies keep conservative restrictions and prevent whole-route acceptance. Persist and replay policy decisions with the exact source, target, graph and context. Unknown external policy outcomes, including interrupted dispatches, must not silently replay; source continuations default to replayUnknown=false. No mathematical target or proof may change through policy repair.

The user selected Deep Agents JS for full integration. Keep LangGraph as the outer review orchestrator and use Deep Agents for tool-driven proof/library workers. Every internal model call must use the application transport, shared concurrency limits, cancellation, budgets and immutable receipts. Do not silently replay unknown outcomes. Keep provider reasoning context private; archive only its digest. Install external libraries at immutable commits in separate directories, verify Lean/mathlib compatibility, compile selected source closures offline in the OS sandbox, and keep existing pinned environments unchanged. Installation/build success is not theorem verification. External imports create a new environment contract with the exact same mathematical target and assumptions, checked again by Lean; author-route checks and source alignment remain separate. New dependencies require regression tests, an actual find/install/Lean/evidence acceptance and a real-paper comparison. The current retest paper is Yang–Zhu unless the user specifies otherwise. Knowledge-base synchronization remains deferred at the user's request.

## Product acceptance principles

Show the selected scope and conclusion before task details. Keep semantic fidelity, original-proof validity, and theorem verification separate. Never promote model opinions, examples, finite search, or missing checks to a verified result. Every final conclusion must link to immutable source/target identities and replayable evidence. Preserve the twelve responsibilities and unfinished requirements in the accepted PRD; a narrow tool fixture is not product completion. Review implementation before user simulation. Use an OpenAI-compatible model adapter with local configuration; never embed credentials or claim a model run occurred without real execution.

The user requested sequential coverage of all three proposed mathematical areas. Use one shared framework and proceed in order: real analysis, linear algebra, then number theory/combinatorics. Validate domain-specific libraries and correct/fault/unknown samples independently. Natural-number smoke tests validate execution infrastructure, not coverage of these domains.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Accepted reader direction · 2026-10-17

Workflow readability feedback: use dark, clearly legible text and status labels. Do not use faint gray-purple text or 9–10px task statuses; workflow metadata should be at least 12px. Branch connectors and node boundaries must remain visible on the light background. Keep state labels in text, and check computed contrast plus desktop/mobile screenshots rather than accepting the appearance alone.

Use Zotero's document/navigation/notes structure and Semantic Reader's in-page markers within Lemma's existing burgundy design. An annotation starts as a short description; only selection expands its title, details, agent contributions and evidence. Users can annotate selections, add comments and open a small contextual AI conversation, then explicitly initiate a review of that exact passage. First-time uploads enter a workflow view with branching responsibilities and a result merge. Nodes reflect actual tasks and dependencies; pending, blocked, confirmation and unimplemented work must remain distinguishable. A completed task or AI explanation is not a verified theorem. Preserve source identities, independent Agent semantic review and its recorded decision, and existing evidence/export/scope functions.

## Simplified reading flow · 2026-10-17

First arrival shows only PDF upload, with saved papers as a secondary library entry. Upload opens the reader immediately, with real review progress on its right. Completed reviews reveal conclusions and Agent annotations only after the user clicks “确定，查看结果”; persist that acknowledgement per paper, run and immutable result root, separately from Agent semantic decision. Results have two tabs, “评审结论” and “批注”. Display each annotation independently beside its anchored PDF text, Word-style, with short collapsed copy and expanded evidence/agent details/comments/Ask AI. Remove the persistent left feature rail and scope tab; retain outline/search/zoom as reader tools and coverage as secondary result details. User-authored notes remain usable during review. Never invent positions for ambiguous quotes. Agent semantic decisions must cite the fixed source and target and must not be reported as kernel proofs.

## Adaptive review path direction · 2026-10-17

The user wants a path chosen from the paper and observed results, not fixed stages or mandatory agent lanes. Show concrete review actions as nodes and agents as executors; the same agent can recur, other agents may never be invoked. Display actual completed/running actions and explicitly scheduled actions, leave undecided future steps open. Connect branches to the findings that caused them, with timely concise progress, source anchors, execution records and evidence on selection. Do not present private reasoning or invent progress percentages. Reading the full paper, autonomous planning, branching, revising and stopping require real backend support; the three mocks under docs/design/adaptive-review-20261017 are design proposals, not implemented capability or review evidence. Preserve result reveal and Agent semantic review as separate gates.

The user accepted the three adaptive-path mocks and requires every visible step to be clickable, with simple details. Use one compact inspector below the path: step/purpose, current result/status, source/evidence links; collapse full execution history by default. Import, reading, running, blocked and completed steps must all have details. Unknown future steps remain uncreated. Preserve selection while new events arrive. The framework-selection note recommends LangGraph.js based on current Node code and official documentation; this is a recommendation, not evidence of installation or tested integration.


## LangGraph implementation · 2026-10-17

User selected LangGraph.js and authorized real frontend/backend implementation. Version 0.9 uses persisted LangGraph checkpoints and evidence-backed task instances, never the static framework topology as user progress. Keep failed attempts and interrupted requests visible; manual retry can reissue unknown external calls, completed steps are reused. Current local gateway has one model execution lane; queued Send branches must not be displayed as concurrent running tasks. A model opinion is not a proof. Root result reveal remains separate from child Agent semantic review. UI acceptance fixtures must stay explicit and isolated from real model/data.

## Autonomous orchestration increment · 2026-10-18

User approved full implementation of the autonomous orchestration proposal. New reviews begin without a mandatory library selection. Read all extractable paper text first, then let the environment Agent choose per-claim profiles and probe real library declarations. Show coverage gaps honestly. Existing runs and their evidence remain immutable and readable.

Separate logical tasks from attempts. Recoverable errors trigger bounded diagnosis and repair within the affected branch; unknown external outcomes must not be silently replayed. Independent tasks use independent checkpoints and resource-limited execution, not a batch barrier. Model concurrency may increase only after actual provider concurrency validation; Lean processes have a separate conservative limit. One pending Agent semantic decision must not block unrelated checks. Preserve exact-target Agent decision and final result reveal as separate gates.

Require concrete derivations, premise checks and counterexamples; independent model opinions are not kernel proofs. Every core claim has a verification-route/coverage record, with actual Lean use reported separately from environment probes. Show queued/running/repairing/unresolved truthfully, retain attempt evidence, and never erase concerns because a concurrent task found no issue. Full implementation requires review, tests, actual local frontend/backend acceptance and incremental knowledge-base records.

The review path must support visible zoom in/out controls, current zoom, reset to 100%, fit-all, wheel/pinch zoom and dragging. User zoom/pan must survive incoming review events and panel resizing; node selection and source/evidence details remain usable.

Keep the path overview readable: group only work that actually exists, expand one claim at a time, fold repeated dispatch/diagnosis into accessible records, and use a narrow vertical layout. Overview connections must derive from actual dependencies. Branch layout shows a primary dependency, with other evidence available on selection; never manufacture sequential dependencies or imply concurrency from grouping. Preserve every original step and its status in the full record.

## Customer-facing copy · 2026-10-18

Keep the user surface focused on uploading, reading, review progress, conclusions, annotations and source evidence. Remove repeated marketing lines, engineering terminology and generic disclaimers from the default view; disclose relevant limits once in expandable review details. Do not render execution statistics or the all-steps/scheduling log anywhere in the customer UI, including collapsed sections. Per-node purpose, result and sources remain accessible. Preserve complete archived evidence and exact-target Agent semantic decision; simplification must not imply verification. Reading-service failure is not zero claims or missing PDF text: distinguish extraction gaps from unfinished AI reading, leave total reading failure resumable and show clear recovery actions. Historical evidence roots must not be rewritten to correct presentation.

## Continuous reading and contextual annotations · 2026-10-18

Read PDFs in one continuous vertical document, not a single page that is replaced. Page number, outline and search navigate within that scroller; scrolling updates the current page without causing another jump. Render nearby canvases lazily and retain measured page extents. Preserve position during zoom and prevent old focus requests from replaying when virtual pages remount. Annotations live next to their actual passage after the separate result acknowledgement gate; remove the separate annotation tab. The result/progress sidebar can collapse for reading. User notes remain available during review. Ambiguous anchors stay explicitly unplaced. Preserve note expansion, comments, contextual AI and Agent semantic review.

## Native PDF outline and compact comments · 2026-10-18

Use only the PDF's embedded bookmark hierarchy for the directory. Expand/collapse branches and resolve named destinations, page references and intra-page targets through PDF.js. A PDF without bookmarks gets a brief empty state, never a page-by-page substitute or invented chapter labels. Failed destination lookups must not jump to a fabricated page; stale asynchronous navigation must not affect another document.

Follow the user's Word reference: keep comments small, collapsed to author and a short excerpt, with a small page-margin marker rather than a large text label. Each comment can expand and collapse; all margin cards can be hidden with the toolbar. Markers remain available to reopen a hidden comment. Preserve original source highlights, independent notes, evidence, discussion, contextual AI and Agent semantic review. Coincident markers must not overlap or cover text. Keep the continuous reader constrained to the viewport in focused reading, including narrow screens.

## Large runtime budgets · 2026-10-19

The user requested increasing all review execution budgets, including request input and time. Active defaults live in server/runtime-limits.mjs and apply consistently to proving, helper decomposition, domain recovery, orchestration, context selection and model/tool timeouts. New proof runs use 256 calls, 50 million aggregate input characters, 1 million per request and 12 hours; new paper reviews use 48 hours. Keep the second-paper continuation script on that shared policy rather than restoring its former 24-call/45-minute cap. Historical run records and controlled benchmark fixtures retain their recorded identities and budgets. Respect actual provider/native model capacities and existing concurrency limits; extended budgets do not change mathematical acceptance or unknown-outcome replay rules.

## Autonomous semantic decisions · 2026-10-19

The user explicitly removed mandatory human semantic confirmation. Agents review all six alignment categories, resolve ambiguities against immutable source evidence and decide proof, counterexample, translation repair, library recovery or unresolved. Do not pause a review to request a human signature. Record Agent authority honestly; never fabricate human attestation. Keep old approvals and source/target versions immutable. An AI semantic decision is not mathematical proof: only an exact target checked by Lean with allowed axioms may be reported machine verified. Unresolvable source ambiguity remains unverified while independent branches continue. Result acknowledgement is a display preference, not authorization to perform verification.

## Source proof verification · 2026-10-19

The user authorized full source-route verification and a two-paper retest. Extract the author's mathematical inference graph with exact PDF anchors, scoped premises, omitted derivations and references. Independently assess source/target fidelity. Check each closed local obligation with Lean, then the assembled root; conditional success with an unproved predecessor is not route success. Preserve the author's invalid step rather than silently strengthening assumptions. Record completions, repairs and independent proofs separately. Inspect elaborated proof constants transitively, declared method restrictions and actual use of dependencies; assembly can reach earlier steps transitively. Independent route assessment is required in addition to kernel acceptance. Known-name checks cannot decide all mathematical equivalences. A route violation in our generated proof is not itself a refutation of the author's mathematics. Local counterexamples must prove the exact local obligation's negation. Every source step remains clickable and anchored beside the paper; hide scheduling/statistics from customers. Preserve successful checkpoints and all failures; continuations create new records and do not silently replay unknown external outcomes. No human semantic signature is required.

## Full-paper entry recovery · 2026-10-20

The full-paper environment probe and inspect_modules tool share pinned declaration resolution and module preparation. Carry only the prepared module manifests into child translation through immutable, paper/run/claim-bound probe receipts; preserve provenance in domain replay and perform a fresh native target check. Source lookup, installation and a diagnostic True target remain non-certifying. Declaration query success must not depend on pretty-printed spelling (for example notation aliases).

A received source-scope proposal that fails structural validation gets bounded feedback to the source Agent, with the rejected proposal and failure receipt preserved. Required definitions must lie in the selected source spans; never weaken the guard or invent text. Retry identity uses source selections and validation failure, not explanation wording. Independent scope review remains mandatory.

Transport recovery may retry only an instrumented connection failure that occurred before request headers were sent. Retain all attempts; a sent request, response-read timeout, HTTP error or unknown outcome never silently replays. Persistent infrastructure failure stops further model dispatch, preserves partial evidence, and marks the review incomplete instead of normally completed. Explicit resume preserves old evidence roots. Customer results and annotations must distinguish an initial model opinion from an unfinished independent review and an actual Lean certificate; saved partial reports still require the separate display acknowledgement.

Publish a terminal model outage before releasing its provider slot. All outer review calls, SDK iterations and prover helpers share the parent dispatch barrier; queued calls check it again before network execution. Preserve the original outage receipt, and record later locally blocked calls as not sent. HTTP 200 followed by a response-read failure is still an unknown outcome; a completed response with invalid formatting is a known failure. Structured review stages must not pass a generic text answer into mathematical scope validation. End-to-end acceptance must traverse the actual HTTP model adapter and Deep Agents tool loop, not only injected parsed-stage objects.

## Execution tools and host admission · protocolVersion 5 · 2026-10-30

The local host admits up to three native Lean execution groups across backend
processes. Resource supervision, cancellation and capacity are independent of
Agent identity and mathematical task order. Source selections can be passed by
immutable selectionId. Agents may inspect and prepare isolated environments,
query same-run public execution history and explicitly reuse an identical
diagnostic receipt with current environment validation. Diagnostic reuse never
creates a new kernel proof or replaces independent proof acceptance. No tool
sequence, proof route or per-task retry limit is prescribed by these facilities.

## Executable tool contracts · protocolVersion 6 · 2026-10-30

New reviews publish and execute one shared tool schema, including unions, typed
references and early profile checks. Short references are durable same-run aliases
for exact immutable identities, never hash prefixes. Original/resolved operation
inputs live in immutable artifacts before dispatch. Missing/ambiguous source
locators and independent full-scope coverage remain separate. Agents choose all
content, decomposition, collaboration, tool ordering and rework.

Managed environment reservations bind verification to use and retain after-use
content verification against external changes. There is no persistent environment
verification cache. In-flight hashing may share work with independent cancellation.
Module acquisition builds private generations and publishes complete snapshots;
existing readers do not hold a shared write lock over downloads. Host capacity is
still three native groups, allocated only to actual managed Lean/Lake work. Keep
accepted reports, diagnostic output, exact proof receipts and objective completion
separate. New protocol stores must not be resumed with an older implementation;
archived reviews remain read-only. No paper-specific route or repair-count stop.

## Explicit shutdown continuation · 2026-10-31

After an explicit user request, a sealed protocol-6 interrupted review may continue
in a new evidence directory with the same logical review ID. Verify and copy its
public immutable artifact graph, PDF identity and sealed state first; the parent
directory and root remain unchanged. A durable single-successor claim prevents
duplicate dispatch from the same checkpoint. Preserve the original budget account,
accepted goals, exact target versions, failed operations and unknown model turns.
Only the coordinator starts a new task version; other interrupted actors and old
requests are never automatically reissued. Agents freely choose the next work.
Record the parent root, imported receipt/operation counts and implementation change
boundary. This is continuation evidence, not a fresh empty-store benchmark. Native
checks and independent acceptance retain their existing contracts and environment
validation. No human proof, fixed mathematical sequence or paper-specific branch
is introduced. Archived reader services do not resume reviews automatically.
