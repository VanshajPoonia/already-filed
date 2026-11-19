# IssueTwin 🦥

**Duplicate GitHub Issue Finder.** Formerly called Already Filed.

Finds the open GitHub issues that say the same thing as an earlier one, so maintainers can type “Duplicate of #…” without remembering thousands of issues. And lets a reporter check before filing.

Point it at a repo. **EmbeddingGemma**, Google's open-weight embedding model, reads every open issue (and every one closed this month) in your browser, and the page lists the open issues that look like one filed before, with the comment ready to copy. Nothing is sent anywhere except the request to GitHub's public API for the issues.

**Live:** https://vanshajpoonia.github.io/already-filed/

<img src="docs/results.png" alt="IssueTwin on a snapshot of ollama/ollama: open issues next to the earlier issues they resemble, with a button to copy Duplicate of" width="640">

## Why

Big repos get the same bug reported again and again. In zed-industries/zed, maintainers have linked **1,653 issues** to the issue they duplicate; the original was filed a median **1,343 issues (64 days) earlier**. Nobody remembers that far back, so every duplicate costs a maintainer a search, or a contributor's time on an issue that is already being worked on elsewhere.

## How it works

<img src="docs/how-it-works.png" alt="How IssueTwin works: GitHub API, then in the tab: clean, EmbeddingGemma, score, you decide" width="720">

- **What gets searched.** On the tuning repo, 91% of the issues maintainers pointed to were still open when the duplicate was filed, and another 7% had been closed in the 30 days before. So each issue is compared with exactly that: issues open at the time, or closed in the last 30 days. It is also all the app needs to fetch.
- **Cleaning** (`src/text.js`). Issue templates make unrelated issues look alike (every ollama issue starts with “What is the issue?”, “OS”, “GPU”, “Ollama version”). Rather than hard-coding any repo's template, a line counts as template text when it appears in more than 2% of the repo's issues. Links, images and all but the first 4 lines of each log are dropped too: the first lines of a log are where the error is.
- **The prompt** (`src/embed.js`). EmbeddingGemma is told what the vectors are for. Its retrieval prompt, `task: search result | query:`, beat the "sentence similarity" prompt I started with by 10 points on the tuning repo's titles (51% against 41% top 3; `node scripts/prompts.mjs` compares five).
- **Three signals** (`src/match.js`). EmbeddingGemma's vector of the title and body (same problem, different words), its vector of the title alone (titles are where people name the bug), and keyword search (BM25) for exact error strings, flags and model names that an embedding blurs. The mix, `0.7 body + 0.3 title + 0.1 keywords`, was picked on the tuning repo from a small grid (`npm run tune`).
- **In the browser.** EmbeddingGemma runs through transformers.js on WebGPU, or WASM where there is none (with the build that keeps the token table unquantised, which the WASM runtime needs). The **ollama/ollama** button opens a snapshot read in advance by the same model (`scripts/snapshot.mjs`, 8-bit vectors), so the demo is instant; anything else is read live.

## Measured

Every number here comes from `npm test`. The data is a frozen snapshot of every issue in three repos (`data/repos`, fetched with `npm run fetch`), with the duplicate links maintainers made: “Duplicate of #123” or GitHub's close-as-duplicate leaves a `MarkedAsDuplicateEvent`, and that is the ground truth. Issues are replayed in the order they were filed; for each one later marked a duplicate, the question is whether the issue it duplicates (or an earlier duplicate of the same one) is among the suggestions.

Everything was chosen on **ollama/ollama** (11,478 issues, 681 linked duplicates) and then frozen. The test repos were not looked at until then.

How the method got there, on the tuning repo (`npm run tune`):

| ollama/ollama (tuning), 681 duplicates | Top 1 | Top 3 | Top 5 |
|---|---|---|---|
| Keyword search (BM25), every earlier issue | 27% | 38% | 44% |
| EmbeddingGemma, "sentence similarity" prompt, every earlier issue | 29% | 42% | 48% |
| ...only issues open then, or closed in the last 30 days | 33% | 49% | 56% |
| ...with the "search result" prompt | 44% | 61% | 66% |
| ...plus the title vector and keywords (shipped) | **46%** | **65%** | **72%** |

Then, frozen, on the test repos (`npm test`). Each new issue is compared with the issues open when it was filed, or closed in the 30 days before:

| zed-industries/zed (test), 1,653 duplicates | Top 1 | Top 3 | Top 5 |
|---|---|---|---|
| Keyword search (BM25) | 25% | 38% | 43% |
| EmbeddingGemma alone | 44% | 62% | 69% |
| bge-small (a sixth of the size), same mix | 45% | 64% | 72% |
| **EmbeddingGemma mix (shipped)** | **45%** | **65%** | **72%** |

| neovim/neovim (test), 379 duplicates | Top 1 | Top 3 | Top 5 |
|---|---|---|---|
| Keyword search (BM25) | 26% | 39% | 45% |
| EmbeddingGemma alone | 42% | 59% | 64% |
| bge-small, same mix | 40% | 56% | 60% |
| **EmbeddingGemma mix (shipped)** | **43%** | **58%** | **64%** |

What the tables say:

- **Where you look matters as much as the model.** Comparing a new issue only with issues that were open at the time is worth 7 points on its own, because old closed issues are almost never the answer and there are thousands of them to be a near miss.
- **The prompt mattered more than the model.** Same weights, one line changed, 12 points on the tuning repo.
- **Embeddings beat keywords by a wide margin** on both test repos: the right issue is in the top three for 65% of zed's duplicates against 38%, and 58% of neovim's against 39%. Of the duplicates only one of them gets, 518 (zed) and 81 (neovim) are EmbeddingGemma's; 64 and 10 are keyword search's.
- **A much smaller model is almost as good** once the recipe is right: bge-small is within two points on ollama and zed, and two to four behind on neovim. EmbeddingGemma is ahead at top three on all three repos, which is why it ships; if 197 MB is too much for your users, the recipe is the part to copy.
- **The mix does not always help.** On neovim, EmbeddingGemma alone was as good as the mix (59% against 58% at top three, 42% against 43% at top one). The weights were fixed on ollama and I left them.
- **The thresholds are conservative.** “Likely” (chosen so 5% of never-linked issues on ollama would get one) shows the right issue for 12% of zed's duplicates while appearing on 4% of its other issues (neovim: 6% and 2%). Most of those are duplicates nobody linked: see below.

### Not every false alarm is false

Maintainers do not link every duplicate. Plenty are closed as “completed” with a comment, or never closed. So an issue with no link that gets a confident suggestion counts as a false alarm above, even when it is a duplicate. `node scripts/audit.mjs <repo> 30` prints 30 of them at random. Reading the 30 it prints for zed: **21 are the same problem** (two even have the same title, word for word), **9 are related** (same feature, a different bug: two Copilot problems in the agent panel, two MCP transport hangs with different triggers), and **none are unrelated**. That is my reading, not the maintainers', and every number above still counts all 30 as wrong.

## Limits

- It suggests; it does not close anything. Some pairs share an error message but not a cause (“exit status 2” has many causes). A maintainer still decides.
- Feature requests are easier than bugs: two people asking for the same thing use the same words.
- Without a token, GitHub allows 60 API requests an hour per network. A repo with 2,500 open issues needs about 30. A fine-grained token with no permissions lifts it; it stays in the tab and goes only to api.github.com.
- English-centred: EmbeddingGemma is multilingual, but the thresholds were chosen on English issues.

## Run it

```bash
npm start              # static server on :8000, no build step
npm install            # only for the scripts and tests
npm test               # unit checks, then the test repos (embeds ~38,000 issues the first time)
npm run tune           # the choices made on ollama/ollama
REPOS=ollama/ollama node tests/eval.mjs   # the tuning repo through the same test
node scripts/audit.mjs zed-industries/zed 30
GITHUB_TOKEN=... npm run fetch owner/name # snapshot another repo
```

The first test run embeds every issue in both test repos and takes a while (about two hours on an M4); vectors are cached in `tests/.cache`.

## Files

```
src/text.js          what part of an issue is compared (template, links, logs)
src/embed.js         the embedding models (shared by the browser and the scripts)
src/bm25.js          keyword search
src/match.js         the mix of signals, and which issues are searched
src/threshold.js     when a suggestion is "likely" or "maybe", chosen on ollama/ollama
src/github.js        open and recently closed issues from GitHub's API
src/model.js         EmbeddingGemma in the browser (WebGPU, or WASM)
src/app.js           UI
scripts/fetch.mjs    freezes a repo's issues and duplicate links into data/repos
scripts/tune.mjs     every choice made on the tuning repo
scripts/audit.mjs    prints "false alarms" to read
scripts/snapshot.mjs the instant demo in data/snapshots
tests/unit.mjs       fast checks, no model
tests/eval.mjs       the test repos
```

## Credits

Model: [EmbeddingGemma](https://huggingface.co/google/embeddinggemma-300m) by Google, under the [Gemma Terms of Use](https://ai.google.dev/gemma/terms), [ONNX build](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX). Comparison model: [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) (MIT). Runtime: [transformers.js](https://github.com/huggingface/transformers.js) and ONNX Runtime Web. Test data: public issues of [ollama/ollama](https://github.com/ollama/ollama), [zed-industries/zed](https://github.com/zed-industries/zed) and [neovim/neovim](https://github.com/neovim/neovim), from GitHub's API.

Code: MIT licence.
