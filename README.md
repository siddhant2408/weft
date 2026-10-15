# Margin

Comment threads on anything you read, where the replies come from AI, and your reading remembers itself.

Highlight a passage on any web page and ask about it. The answer appears in a comment card beside the passage, like a comment in Notion or Google Docs. Come back days later and the passage is still highlighted, with the conversation one click away. When something you're reading touches a thread from another page, Margin brings what you concluded there into the answer and links back to it.

Margin runs entirely in your browser. Your notes stay in Chrome, and the only thing sent anywhere is what you ask, to the model you choose.

## How Margin works

Every thread is pinned to the passage it's about. When you ask a question, the model sees the passage and its paragraph, the page title and summary, the conversation so far, and your notes on the page: what you've concluded and what's still open. If it needs more of the page, it says so and you can share the page with one click.

Each thread is tagged with the ideas it's about, and the tags follow the conversation as it moves. Before a reply, Margin looks for threads on other pages that share a tag, and a small scoring model judges which of them would help with this question. Up to three go along with your question, and the reply cites them, e.g. "the same versioning as in your Postgres thread [R2]", linking to the original passage.

More detail: [docs/architecture.md](docs/architecture.md) and [docs/related-threads.md](docs/related-threads.md).

## Features

- **Comment threads on any passage.** Select text, ask, and the reply streams in beside it. Follow up as many times as you like.
- **Quick actions.** Explain, Define, Simplify, Fact-check or Counterpoint in one click.
- **Notes and highlights.** Add your own notes to a thread, or keep a highlight without asking anything.
- **Takeaways.** Resolve a thread and Margin drafts a one-line takeaway for you to accept or edit.
- **Related threads.** Conclusions and open questions from other pages come back when they're relevant, with citations.
- **Page notebook.** The side panel shows the page's gist, what you've learned, what's still open, and a thread about the page as a whole.
- **All threads.** Every thread across every page, as a searchable list or a graph of how they connect.
- **Copy as notes.** A page's threads as Markdown, with links that open the page scrolled to each passage.
- **Your choice of model.** Your ChatGPT plan (Go, Plus or Pro), or any model on OpenRouter, including free ones.

## Install

Margin isn't on the Chrome Web Store yet. To install it from source:

1. Download this repository (Code → Download ZIP, then unzip) or `git clone` it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the folder.
3. Click the Margin icon, open **Settings**, and choose who replies:
   - **ChatGPT:** click **Continue with ChatGPT** and sign in. Replies use your ChatGPT plan; no API key needed.
   - **OpenRouter:** click **Connect OpenRouter** and approve. Free models work without credits.
4. Optional, under **Related threads**: score related threads with Jev, through OpenRouter (needs credits) or your own [TypeSafe](https://console.typesafe.ai) key. Without it, the closest matches by shared words are used.
5. Optional, on macOS: run `./native-host/install.sh` to back up every note to a local SQLite file.

Then select some text on any page and ask.

## Privacy

- Notes, highlights and conversations are stored in Chrome on your machine.
- Nothing is sent until you send a comment or click Summarise. A question sends the passage, its paragraph, the thread and any related threads to the model you chose; the full page is sent only to summarise it.
- Margin does nothing at all on excluded sites. Banking and mail sites are excluded by default, and you can add your own.
- Export everything as JSON or delete it all from Settings.

What is sent where, and how keys and sign-ins are stored: [docs/privacy.md](docs/privacy.md).

## Contributing

Plain JavaScript, no build step, no dependencies. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions and tests.

## License

[MIT](LICENSE). Bundled in `vendor/`: [Readability](https://github.com/mozilla/readability) (Apache 2.0), [marked](https://github.com/markedjs/marked) (MIT) and [DOMPurify](https://github.com/cure53/DOMPurify) (Apache 2.0 or MPL 2.0), each with its license header.
