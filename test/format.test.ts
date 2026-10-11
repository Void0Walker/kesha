import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markdownToHtml, replyContent } from "../src/format.ts";

const URL = "https://plans.example.org";

describe("markdownToHtml", () => {
  it("renders emphasis, lists and task links", () => {
    assert.equal(
      markdownToHtml("Due today in **Home**:\n- Fix seal (#41)\n- Order *filter* (#43)", { vikunjaUrl: URL }),
      `<p>Due today in <strong>Home</strong>:</p><ul><li>Fix seal (<a href="${URL}/tasks/41">#41</a>)</li><li>Order <em>filter</em> (<a href="${URL}/tasks/43">#43</a>)</li></ul>`,
    );
  });

  it("keeps paragraphs, line breaks and numbered lists", () => {
    assert.equal(markdownToHtml("a\nb\n\n1. one\n2. two\n\nend"), "<p>a<br>b</p><ol><li>one</li><li>two</li></ol><p>end</p>");
  });

  it("escapes HTML from the model or from restored names and titles", () => {
    assert.equal(markdownToHtml(`<img src=x onerror=alert(1)> "Jo" O'Neil & <b>`), "<p>&lt;img src=x onerror=alert(1)&gt; &quot;Jo&quot; O&#39;Neil &amp; &lt;b&gt;</p>");
    assert.equal(markdownToHtml("[click](javascript:alert(1))"), "<p>[click](javascript:alert(1))</p>");
    assert.equal(markdownToHtml(`[x](https://a.example/"onmouseover=1)`), `<p><a href="https://a.example/&quot;onmouseover=1">x</a></p>`);
  });

  it("doesn't italicise arithmetic, snake_case or stars inside names", () => {
    assert.equal(markdownToHtml("5 * 3 * 2 = 30, my_var_name, A*B*C"), "<p>5 * 3 * 2 = 30, my_var_name, A*B*C</p>");
  });

  it("links bare URLs without trailing punctuation and leaves code alone", () => {
    assert.equal(markdownToHtml("See https://nodejs.org/en. Run `a **b** <c>`"),
      `<p>See <a href="https://nodejs.org/en">https://nodejs.org/en</a>. Run <code>a **b** &lt;c&gt;</code></p>`);
  });

  it("makes no task links without a Vikunja URL", () => {
    assert.equal(markdownToHtml("Moved (#41)."), "<p>Moved (#41).</p>");
  });
});

describe("replyContent", () => {
  it("adds the footer small and grey, and keeps a plain body", () => {
    const c = replyContent("Done (#7).", { vikunjaUrl: URL }, "— $0.0012 · today $0.0400 of $1.00");
    assert.equal(c.body, "Done (#7).\n\n— $0.0012 · today $0.0400 of $1.00");
    assert.equal(c.formatted_body, `<p>Done (<a href="${URL}/tasks/7">#7</a>).</p><p><sub><span data-mx-color="#888888">— $0.0012 · today $0.0400 of $1.00</span></sub></p>`);
    assert.equal(c.format, "org.matrix.custom.html");
  });
});
