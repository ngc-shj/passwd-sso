#!/usr/bin/env python3
"""Command-string scanner for .claude/hooks/block-bare-decrypt.sh.

Walks a shell command ONCE, tracking quote state, nesting depth ($( ), a
backtick span, a ( ) subshell, `<( )`/`>( )` process substitution — each
scanned recursively as its own command list) and heredoc bodies, and splits
it into simple commands ("segments") at unquoted, unnested `| |& ; & &&`
`||` and newline. This is the ONE adjudicator for the hook: every rule below
asks a question of one parsed segment, never of the raw command text, which
is what closes the false negatives a window regex cannot see (a quoted
operator that ends a text match early; an operator inside `$( … )` that a
quote-only scanner treats as a real split point).

Inside a recognised Shape 1 (`_CRED=$(… decrypt …)`), the segment-level rules
below are not the only gate: `_effective_command_word` asks, of every
segment, which word bash would actually run. A segment whose answer it
cannot attribute — a shell keyword, an invocation prefix like `command` or
`sudo` that execs its own operand tail, anything not a plain literal name —
is refused outright rather than judged against rules that assumed a plain
simple command. `env NAME=value … cmd` is the one prefix this resolves past,
since the contract keeps that form allowed; every other rule reads the
resolved word through `_rule_command_word`, falling back to the raw,
unresolved word so a rule that WOULD refuse it (`bash -x`, `xargs …`) still
does, under its own message.

Two entry points, both over the command read from stdin:
  --segments   dumps the parsed tree as JSON (the unit-test boundary, A-C1-0).
  --verdict    dumps {"decision": "allow"} or {"decision": "block", "message": …}
               for the hook to relay verbatim.

A parse that cannot complete (unbalanced quote, unterminated nesting, a
heredoc whose terminator never appears) raises ParseError. The caller (the
hook) treats ANY non-zero exit from this script — a raised ParseError, or any
other exception — as "the scanner did not decide" and refuses; this script
does not decide that for itself; it fails loudly, stdlib-only, no third-party
imports.
"""
from __future__ import annotations

import json
import re
import sys

CRED_NAME = "_CRED"

# Longest-first so "&&" is not read as "&" followed by "&".
_OPERATORS = ("&&", "||", "|&", "|", ";", "&")

# Item 6: the widened printer list. A segment refuses when its command word is
# here AND _CRED is referenced anywhere in that segment (words, here-string,
# heredoc) — decided per segment, never over the raw command text (F-R2-2).
PRINTER_WORDS = {
    "echo", "printf", "cat", "tee", "printenv", "base64", "xxd", "od",
    "hexdump", "openssl", "rev", "awk", "sed", "head", "tail", "dd", "paste",
    "tr", "iconv", "jq", "xargs", "column", "fold", "fmt", "nl", "pr",
    "less", "more",
}

# Item 2: dumpers that reveal every variable, not just a named one.
_DUMPER_WORDS = {"declare", "typeset", "local", "export", "readonly"}
_BARE_DUMPER_WORDS = {"set", "env", "printenv", "export"}

# Shape 2's clipboard sinks — unchanged in meaning from the old CLIP_RE, now
# matched as a whole invocation (word list), not as a name, so a re-emitting
# flag (`xclip -filter`, `xsel --output`) still falls through to refusal.
_CLIP_INPUT_FLAGS = {"--input", "-i"}
_CLIP_MODE_FLAGS = {"--clipboard", "--primary", "--secondary"}


class ParseError(Exception):
    """The scanner could not make sense of the command (item 8)."""


# --------------------------------------------------------------------------
# Parsed structure
# --------------------------------------------------------------------------

class Heredoc:
    __slots__ = ("delim", "quoted", "strip_tabs", "body", "nested")

    def __init__(self, delim: str, quoted: bool, strip_tabs: bool):
        self.delim = delim
        self.quoted = quoted
        self.strip_tabs = strip_tabs
        self.body = ""
        # Command substitutions found in the body of an UNQUOTED heredoc.
        # Bash expands those exactly as it does inside double quotes, so the
        # commands in them run — see _consume_heredoc_bodies.
        self.nested: list[tuple[str, list["Segment"]]] = []

    def to_json(self):
        return {
            "delimiter": self.delim,
            "quoted": self.quoted,
            "strip_tabs": self.strip_tabs,
            "body": self.body,
            "nested": [{"kind": k, "segments": [s.to_json() for s in segs]} for k, segs in self.nested],
        }


class Redir:
    __slots__ = ("op", "target")

    def __init__(self, op: str, target: str):
        self.op = op
        self.target = target  # raw text (quotes intact — see module docstring: substring/regex matching over raw text is enough, full dequoting is not needed)

    def to_json(self):
        return {"op": self.op, "target": self.target}


class Segment:
    """One simple command bash would run as a unit between two operators."""

    def __init__(self, join_op: str | None):
        self.join_op = join_op  # the operator that PRECEDES this segment, or None for the first in its list
        self.assignments: list[tuple[str, str]] = []  # leading NAME=value words, before the command word
        self.words: list[str] = []  # raw text, command word first, then arguments (quotes intact)
        self.redirs: list[Redir] = []
        self.heredocs: list[Heredoc] = []
        self.nested: list[tuple[str, list["Segment"]]] = []  # ("cmdsub"|"backtick"|"subshell", segments) found anywhere in this segment's text
        self.command_seen = False  # once a non-assignment word appears, later NAME=value words are ordinary arguments (F-F4)

    def to_json(self):
        return {
            "join_op": self.join_op,
            "assignments": [{"name": n, "value": v} for n, v in self.assignments],
            "words": list(self.words),
            "redirections": [r.to_json() for r in self.redirs],
            "heredocs": [h.to_json() for h in self.heredocs],
            "nested": [{"kind": k, "segments": [s.to_json() for s in segs]} for k, segs in self.nested],
        }

    @property
    def command_word(self) -> str | None:
        return self.words[0] if self.words else None


# --------------------------------------------------------------------------
# Tokenizer / parser
#
# One class, one pass. `parse()` handles top level and is also what a nested
# region recurses into — the same operator/quote/heredoc rules apply inside
# `$( … )`, a backtick span and a `( … )` subshell, because bash parses them
# with the very same grammar. Word content is kept RAW (quotes and all): the
# rules below search words with a regex tolerant of surrounding quotes rather
# than reconstructing bash's expansion, which the "is this segment safe"
# question never needs (see module docstring).
# --------------------------------------------------------------------------

class Parser:
    def __init__(self, s: str):
        self.s = s
        self.n = len(s)
        self.i = 0
        # Top of stack is the terminator the INNERMOST parse() call is
        # waiting for (None at top level). A word must stop there too — a
        # word scan that does not know about the enclosing $( … ) / backtick
        # / ( … ) swallows its close as ordinary word text and the region
        # never finds its terminator.
        self._term_stack: list[str | None] = []

    # -- low-level helpers ---------------------------------------------

    def _peek(self, offset: int = 0) -> str:
        j = self.i + offset
        return self.s[j] if j < self.n else ""

    def _match_operator(self) -> str | None:
        for op in _OPERATORS:
            if self.s.startswith(op, self.i):
                return op
        return None

    # -- quoted / nested span consumption --------------------------------
    # Each of these returns the RAW text consumed (delimiters included) and
    # advances self.i past it. $( ), backtick and ( ) spans are also parsed
    # recursively and the resulting segment list is appended to `nested_out`.

    def _consume_single_quoted(self) -> str:
        start = self.i
        assert self.s[self.i] == "'"
        self.i += 1
        while True:
            if self.i >= self.n:
                raise ParseError("unterminated single-quoted string")
            if self.s[self.i] == "'":
                self.i += 1
                return self.s[start:self.i]
            self.i += 1

    def _consume_double_quoted(self, nested_out: list) -> str:
        # Built from parts, not a single slice: item 1 removes a `\<newline>`
        # continuation in double-quoted context too, and a slice of the
        # original text would keep it — the printer check then fails to
        # recognise `"ec\<newline>ho"` as `echo` (round 2-class bug, S-F6).
        assert self.s[self.i] == '"'
        parts = ['"']
        self.i += 1
        plain_start = self.i
        while True:
            if self.i >= self.n:
                raise ParseError("unterminated double-quoted string")
            c = self.s[self.i]
            if c == "\\":
                nxt = self._peek(1)
                if nxt == "\n":
                    parts.append(self.s[plain_start:self.i])
                    self.i += 2
                    plain_start = self.i
                    continue
                if nxt in ("$", "`", '"', "\\"):
                    self.i += 2
                    continue
                self.i += 1
                continue
            if c == '"':
                parts.append(self.s[plain_start:self.i])
                self.i += 1
                parts.append('"')
                return "".join(parts)
            if c == "$" and self._peek(1) == "(":
                parts.append(self.s[plain_start:self.i])
                parts.append(self._consume_cmdsub(nested_out))
                plain_start = self.i
                continue
            if c == "`":
                parts.append(self.s[plain_start:self.i])
                parts.append(self._consume_backtick(nested_out))
                plain_start = self.i
                continue
            if c == "$" and self._peek(1) == "{":
                parts.append(self.s[plain_start:self.i])
                parts.append(self._consume_dollar_brace(nested_out))
                plain_start = self.i
                continue
            self.i += 1

    def _consume_dollar_brace(self, nested_out: list) -> str:
        # ${ … } — only brace/quote balance matters here: an operator
        # character inside is not a split point (`${x:-a|b}`), and a nested
        # $( … ) or backtick inside still needs recursing into (the same
        # reasoning as double quotes above).
        start = self.i
        assert self.s[self.i:self.i + 2] == "${"
        self.i += 2
        depth = 1
        while depth > 0:
            if self.i >= self.n:
                raise ParseError("unterminated ${ … } expansion")
            c = self.s[self.i]
            if c == "'":
                self._consume_single_quoted()
                continue
            if c == '"':
                self._consume_double_quoted(nested_out)
                continue
            if c == "\\":
                self.i += 2 if self.i + 1 < self.n else 1
                continue
            if c == "{":
                depth += 1
                self.i += 1
                continue
            if c == "}":
                depth -= 1
                self.i += 1
                continue
            if c == "$" and self._peek(1) == "(":
                self._consume_cmdsub(nested_out)
                continue
            if c == "`":
                self._consume_backtick(nested_out)
                continue
            self.i += 1
        return self.s[start:self.i]

    def _consume_cmdsub(self, nested_out: list) -> str:
        start = self.i
        assert self.s[self.i:self.i + 2] == "$("
        self.i += 2
        segs = self.parse(terminator=")")
        nested_out.append(("cmdsub", segs))
        return self.s[start:self.i]

    def _consume_backtick(self, nested_out: list) -> str:
        start = self.i
        assert self.s[self.i] == "`"
        self.i += 1
        segs = self.parse(terminator="`")
        nested_out.append(("backtick", segs))
        return self.s[start:self.i]

    def _consume_procsub(self, nested_out: list) -> str:
        start = self.i
        assert self.s[self.i] in "<>" and self.s[self.i + 1] == "("
        self.i += 2
        segs = self.parse(terminator=")")
        nested_out.append(("procsub", segs))
        return self.s[start:self.i]

    def _consume_subshell(self, nested_out: list) -> str:
        start = self.i
        assert self.s[self.i] == "("
        self.i += 1
        segs = self.parse(terminator=")")
        nested_out.append(("subshell", segs))
        return self.s[start:self.i]

    # -- word scanning ----------------------------------------------------

    def _scan_word(self, nested_out: list, allow_leading_paren: bool) -> str:
        """Scans one word (blank/operator/redirection-delimited) starting at self.i.

        Returns its text, built from parts rather than one slice: item 1's
        `\\<newline>` continuation is removed here (unquoted context) and
        inside `_consume_double_quoted` (double-quoted context) — a plain
        slice of the source would keep the continuation as two literal
        characters, and `ec\\<newline>ho` would then never read as `echo`.

        A word directly starting with `(` when `allow_leading_paren` is set
        is instead treated by the caller as a subshell compound command, not
        a word — see parse()'s dispatch.
        """
        parts: list[str] = []
        plain_start = self.i
        first = True
        while self.i < self.n:
            c = self.s[self.i]
            if c == "'":
                parts.append(self.s[plain_start:self.i])
                parts.append(self._consume_single_quoted())
                plain_start = self.i
                first = False
                continue
            if c == '"':
                parts.append(self.s[plain_start:self.i])
                parts.append(self._consume_double_quoted(nested_out))
                plain_start = self.i
                first = False
                continue
            if c == "\\":
                nxt = self._peek(1)
                if nxt == "\n":
                    # Item 1: a line continuation is not word content and does
                    # not end the word — bash joins the two physical lines.
                    # Only outside single quotes, which never reach here.
                    parts.append(self.s[plain_start:self.i])
                    self.i += 2
                    plain_start = self.i
                    continue
                self.i += 2 if self.i + 1 < self.n else 1
                first = False
                continue
            if c == "$" and self._peek(1) == "(":
                parts.append(self.s[plain_start:self.i])
                parts.append(self._consume_cmdsub(nested_out))
                plain_start = self.i
                first = False
                continue
            if c == "`":
                # Only an OPENING backtick starts a region. When the innermost
                # parse is itself waiting for a backtick, this one closes it,
                # and the word ends here — consuming it as an opener made the
                # region unterminated, so `echo `date`` (any backtick
                # substitution at all) raised ParseError and the hook refused
                # an ordinary command. main allowed those: a parser defect
                # this branch introduced, found in round 5 while wiring
                # heredoc bodies.
                if self._term_stack and self._term_stack[-1] == "`":
                    break
                parts.append(self.s[plain_start:self.i])
                parts.append(self._consume_backtick(nested_out))
                plain_start = self.i
                first = False
                continue
            if c == "$" and self._peek(1) == "{":
                parts.append(self.s[plain_start:self.i])
                parts.append(self._consume_dollar_brace(nested_out))
                plain_start = self.i
                first = False
                continue
            if c == "(" and first and allow_leading_paren:
                # A `(` beginning a fresh word IS the word: an embedded
                # subshell used as a value, e.g. a nameref target. Treated
                # like any other nested region.
                parts.append(self.s[plain_start:self.i])
                parts.append(self._consume_subshell(nested_out))
                plain_start = self.i
                first = False
                continue
            if c in (" ", "\t", "\n"):
                break
            if self._match_operator() is not None:
                break
            if c in "<>":
                break
            if self._term_stack and c == self._term_stack[-1]:
                break
            self.i += 1
            first = False
        parts.append(self.s[plain_start:self.i])
        return "".join(parts)

    # -- redirection --------------------------------------------------------

    def _parse_redirection(self, seg: Segment, pending_heredocs: list):
        # Optional leading fd digits (2>, 1>&2 — the digits are not part of
        # the operator token bash recognises, but they do not change which
        # operator this is for our purposes, so they are simply skipped).
        while self.i < self.n and self.s[self.i].isdigit():
            self.i += 1
        if self.s.startswith("<<<", self.i):
            self.i += 3
            nested_here: list = []
            target = self._scan_redir_target_word_collecting(nested_here)
            seg.nested.extend(nested_here)
            seg.redirs.append(Redir("<<<", target))
            return
        if self.s.startswith("<<-", self.i) or self.s.startswith("<<", self.i):
            strip_tabs = self.s.startswith("<<-", self.i)
            self.i += 3 if strip_tabs else 2
            while self.i < self.n and self.s[self.i] in (" ", "\t"):
                self.i += 1
            delim_start = self.i
            delim_raw = self._scan_word([], allow_leading_paren=False)
            if delim_raw == "":
                raise ParseError("heredoc with no delimiter")
            quoted = ("'" in delim_raw) or ('"' in delim_raw) or ("\\" in delim_raw)
            delim = _strip_quotes(delim_raw)
            hd = Heredoc(delim, quoted, strip_tabs)
            seg.heredocs.append(hd)
            pending_heredocs.append(hd)
            return
        if self.s.startswith(">>", self.i):
            self.i += 2
            target = self._scan_redir_target_word_collecting_into(seg)
            seg.redirs.append(Redir(">>", target))
            return
        if self.s.startswith("&>", self.i):
            self.i += 2
            target = self._scan_redir_target_word_collecting_into(seg)
            seg.redirs.append(Redir("&>", target))
            return
        c = self.s[self.i]
        assert c in "<>"
        self.i += 1
        if self.i < self.n and self.s[self.i] == "&":
            # >&2, <&3 — a duplication target, not a word (no nesting to scan).
            self.i += 1
            fd_start = self.i
            while self.i < self.n and self.s[self.i].isdigit():
                self.i += 1
            seg.redirs.append(Redir(c + "&", self.s[fd_start:self.i]))
            return
        target = self._scan_redir_target_word_collecting_into(seg)
        seg.redirs.append(Redir(c, target))

    def _scan_redir_target_word_collecting_into(self, seg: Segment) -> str:
        while self.i < self.n and self.s[self.i] in (" ", "\t"):
            self.i += 1
        nested: list = []
        target = self._scan_word(nested, allow_leading_paren=False)
        seg.nested.extend(nested)
        return target

    def _scan_redir_target_word_collecting(self, nested_out: list) -> str:
        while self.i < self.n and self.s[self.i] in (" ", "\t"):
            self.i += 1
        return self._scan_word(nested_out, allow_leading_paren=False)

    # -- heredoc body consumption --------------------------------------

    def _consume_heredoc_bodies(self, pending: list[Heredoc]):
        # Consumed in redirection order (F-R3-3), each up to a line that is
        # EXACTLY its delimiter (leading tabs stripped on both sides only for
        # `<<-`). The body is not operator-scannable: its `;` and `|` are
        # literal text, which is why item 5 reads it as text.
        #
        # It is NOT inert, though, and treating it as inert was a fail-open:
        # with an unquoted delimiter bash expands `$( … )` and backticks in a
        # heredoc body exactly as it does inside double quotes, so
        # `cat <<EOF` / `$(passwd-sso decrypt X)` / `EOF` runs the decrypt and
        # prints it — and detection, which only ever walked `seg.nested`,
        # never saw the call (round 5). Those spans are parsed here and hung
        # on the heredoc, so every rule that walks nested segments reaches
        # them. A QUOTED delimiter disables expansion, so its body stays text.
        for hd in pending:
            lines = []
            while True:
                if self.i > self.n:
                    break
                line_end = self.s.find("\n", self.i)
                line = self.s[self.i:] if line_end == -1 else self.s[self.i:line_end]
                probe = line.lstrip("\t") if hd.strip_tabs else line
                at_end = line_end == -1
                if probe == hd.delim:
                    self.i = self.n if at_end else line_end + 1
                    break
                lines.append(line.lstrip("\t") if hd.strip_tabs else line)
                # A heredoc that reaches end of input without its terminator is
                # NOT a syntax error to bash: it warns and runs the command with
                # everything collected so far as the body. Raising here made the
                # hook refuse commands bash accepts — a mistyped terminator, and
                # every CRLF-authored heredoc, since the opener's delimiter word
                # keeps the `\r` while the terminator line does not (round 6).
                # The body still goes through substitution parsing below, so a
                # decrypt inside one is found either way.
                if at_end:
                    self.i = self.n
                    break
                self.i = line_end + 1
            hd.body = "\n".join(lines)
            if not hd.quoted:
                hd.nested = _parse_substitutions_in(hd.body)

    # -- top-level driver -----------------------------------------------

    def parse(self, terminator: str | None) -> list[Segment]:
        self._term_stack.append(terminator)
        try:
            return self._parse_body(terminator)
        finally:
            self._term_stack.pop()

    def _parse_body(self, terminator: str | None) -> list[Segment]:
        segments: list[Segment] = []
        # A single-element list so the nested `finish` closure can rebind it
        # (Python's `nonlocal` cannot target a name that is also reassigned
        # by a `:=` in the enclosing scope, so a cell is simpler than a flag).
        state = {"seg": Segment(join_op=None), "any_token": False}
        pending_heredocs: list[Heredoc] = []

        def finish(next_join):
            segments.append(state["seg"])
            state["seg"] = Segment(join_op=next_join)
            state["any_token"] = False

        while True:
            # Blanks (not newline) are always insignificant between tokens,
            # and so is a line continuation here: a `\<newline>` that falls
            # BETWEEN two words is not the start of a new word (item 1) — it
            # only needs special handling inside _scan_word for the case
            # where it falls INSIDE one (`ec\<newline>ho`).
            while self.i < self.n and (
                self.s[self.i] in (" ", "\t")
                or (self.s[self.i] == "\\" and self._peek(1) == "\n")
            ):
                self.i += 2 if self.s[self.i] == "\\" else 1
            if self.i >= self.n:
                if terminator is not None:
                    raise ParseError(f"unterminated region, expected {terminator!r}")
                break
            c = self.s[self.i]
            if terminator is not None and c == terminator:
                self.i += 1
                break
            if c == "\n":
                self.i += 1
                if pending_heredocs:
                    self._consume_heredoc_bodies(pending_heredocs)
                    pending_heredocs = []
                if state["any_token"]:
                    finish(None)
                continue
            op = self._match_operator()
            if op is not None:
                self.i += len(op)
                if not state["any_token"] and not segments:
                    raise ParseError(f"operator {op!r} with no preceding command")
                finish(op)
                continue
            if c.isdigit():
                j = self.i
                while j < self.n and self.s[j].isdigit():
                    j += 1
                if j < self.n and self.s[j] in "<>":
                    self.i = j
                    self._parse_redirection(state["seg"], pending_heredocs)
                    state["any_token"] = True
                    continue
            if c == "#":
                # A `#` STARTING a word is a comment to end of line. Reached
                # only at a word boundary here (blanks skipped, operators and
                # redirections already dispatched), so `echo a#b` is untouched.
                nl = self.s.find("\n", self.i)
                self.i = self.n if nl == -1 else nl
                continue
            if c in "<>" and self._peek(1) == "(":
                # Process substitution is a NESTED REGION, parsed recursively
                # like $( … ): without this the `;` inside `<(true; false)` is
                # read as a top-level split point and the rest of the command
                # lands in a segment whose command word is the shard `false)`.
                nested: list = []
                word = self._consume_procsub(nested)
                state["seg"].nested.extend(nested)
                _classify_word(state["seg"], word)
                state["any_token"] = True
                continue
            if c in "<>":
                self._parse_redirection(state["seg"], pending_heredocs)
                state["any_token"] = True
                continue
            if c == "(" and not state["any_token"]:
                self._consume_subshell(state["seg"].nested)
                state["any_token"] = True
                continue
            nested: list = []
            word = self._scan_word(nested, allow_leading_paren=False)
            if word == "":
                raise ParseError(f"unexpected character {c!r}")
            state["seg"].nested.extend(nested)
            _classify_word(state["seg"], word)
            state["any_token"] = True

        seg = state["seg"]
        if state["any_token"] or seg.assignments or seg.words or seg.redirs or seg.heredocs or seg.nested or not segments:
            segments.append(seg)
        return segments


def _strip_quotes(word: str) -> str:
    """Best-effort: drop a SINGLE pair of quote characters wrapping the whole
    word, and unescape a backslash-quote pair — enough to compare a command
    word or a heredoc delimiter against a literal name (round 16: `"printf"`
    must still read as printf). Interior text is not otherwise touched — see
    the module docstring on why raw substring matching is used elsewhere."""
    out = []
    i = 0
    n = len(word)
    while i < n:
        c = word[i]
        if c == "'":
            j = word.find("'", i + 1)
            j = n if j == -1 else j
            out.append(word[i + 1:j])
            i = j + 1
            continue
        if c == '"':
            j = i + 1
            buf = []
            while j < n and word[j] != '"':
                if word[j] == "\\" and j + 1 < n and word[j + 1] in ('$', '`', '"', '\\'):
                    buf.append(word[j + 1])
                    j += 2
                    continue
                buf.append(word[j])
                j += 1
            out.append("".join(buf))
            i = j + 1
            continue
        if c == "\\" and i + 1 < n:
            out.append(word[i + 1])
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*$")


def _classify_word(seg: Segment, word: str):
    """A leading NAME=value word (unquoted name, unquoted `=`) is an
    assignment as long as no non-assignment word has appeared yet in this
    segment (F-F4: `echo FOO=bar` is an argument, not an assignment)."""
    if not seg.command_seen:
        eq = _unquoted_equals_index(word)
        if eq is not None:
            name = word[:eq]
            if _NAME_RE.match(name):
                seg.assignments.append((name, word[eq + 1:]))
                return
    seg.command_seen = True
    seg.words.append(word)


def _unquoted_equals_index(word: str) -> int | None:
    """Index of the first UNQUOTED, unescaped `=` in `word`, or None."""
    q = None
    i = 0
    n = len(word)
    while i < n:
        c = word[i]
        if q is not None:
            if q == '"' and c == "\\":
                i += 2
                continue
            if c == q:
                q = None
            i += 1
            continue
        if c == "\\":
            i += 2
            continue
        if c in ("'", '"'):
            q = c
            i += 1
            continue
        if c == "=":
            return i
        i += 1
    return None


def _parse_substitutions_in(text: str) -> list[tuple[str, list["Segment"]]]:
    """Every `$( … )` and backtick span inside `text`, parsed as commands.

    Used for the body of an unquoted heredoc, where bash performs the same
    expansions it performs inside double quotes. A scan of the body's own
    text is what makes those commands visible to the rules; the body itself
    is not a command list (its `;` and `|` are literal), so only the
    substitutions are parsed, exactly as `_consume_double_quoted` does for a
    word.
    """
    found: list[tuple[str, list[Segment]]] = []
    p = Parser(text)
    p._term_stack.append(None)
    while p.i < p.n:
        ch = p.s[p.i]
        if ch == "\\":
            p.i += 2
            continue
        if ch == "$" and p._peek(1) == "(":
            p._consume_cmdsub(found)
            continue
        if ch == "`":
            p._consume_backtick(found)
            continue
        p.i += 1
    return found


def parse_command(command: str) -> list[Segment]:
    return Parser(command).parse(terminator=None)


def iter_all_segments(segments: list[Segment]):
    """Every segment reachable from `segments`, at any nesting depth — decrypt
    detection and the printer/dumper/tracer rules all apply "at any nesting
    depth" (item 6), which this is the single place that provides."""
    for seg in segments:
        yield seg
        for _kind, inner in seg.nested:
            yield from iter_all_segments(inner)
        # An unquoted heredoc's body is expanded by bash, so the commands its
        # substitutions contain do run (round 5).
        for hd in seg.heredocs:
            for _kind, inner in hd.nested:
                yield from iter_all_segments(inner)


# --------------------------------------------------------------------------
# Verdict rules
# --------------------------------------------------------------------------

_CRED_REF_RE = re.compile(r"\$\{?" + re.escape(CRED_NAME) + r"\b\}?")


def _word_references_cred(word: str) -> bool:
    # `$_CRED` / `${_CRED}` anywhere in the raw text (quotes do not hide the
    # substring — see the module docstring), or the bare name itself, which
    # is how `printenv _CRED` names the variable without a `$` (item 6).
    dequoted = _strip_quotes(word)
    return bool(_CRED_REF_RE.search(word)) or dequoted == CRED_NAME


def _text_references_cred(text: str) -> bool:
    return bool(_CRED_REF_RE.search(text))


def _segment_references_cred(seg: Segment) -> bool:
    """Item 6's "anywhere in that segment": its words, its here-string, its
    heredoc (heredoc only counts when the delimiter is unquoted — a quoted
    delimiter disables expansion, so literal text "_CRED" in the body is not
    the credential; item 5 owns that distinction and this reuses it)."""
    if any(_word_references_cred(w) for w in seg.words):
        return True
    for r in seg.redirs:
        if r.op == "<<<" and _word_references_cred(r.target):
            return True
    for hd in seg.heredocs:
        if not hd.quoted and _text_references_cred(hd.body):
            return True
    return False


def _is_decrypt_segment(seg: Segment) -> bool:
    """A segment whose command word (or its `npx tsx …` operand) is the CLI
    with `decrypt` as its first operand (F-R3-2).

    Matched on the RAW word text, deliberately not dequoted: a quoted or
    split subcommand (`passwd-sso 'decrypt' x`, `passwd-sso decr"ypt" x`) is
    the "known evasions" class the header still lists as residual (SC2) — C1
    widens the PRINTER/dumper/tracer command-word matching to see through
    quoting, not this. Narrowing this match would silently close a gap the
    plan does not claim to close (R-1)."""
    words = seg.words
    if not words:
        return False
    # Both spellings are looked for at ANY position, never only at words[0].
    #
    # Position-anchoring is what let an invocation prefix hide the call. The
    # first revision answered that by stripping a list of prefixes, which
    # works only while the prefix is spelled bare: `sudo passwd-sso decrypt x`
    # was seen, `sudo -u alice passwd-sso decrypt x` was not, because the
    # option left `-u` where the CLI name was expected and detection reported
    # "no decrypt here" — the allow arm, before any rule ran (round 3, R3-F1).
    # The same held for `nice -n 10`, `env -i`, `ionice -c3`, `exec -a`.
    #
    # Modelling each prefix's option grammar is the approach round 1's
    # escalation already rejected as fragile, and refusing whatever cannot be
    # resolved is not available here: this hook runs on EVERY Bash command, so
    # "an option-bearing prefix I cannot resolve" would refuse an ordinary
    # `sudo -u alice ls`. Scanning positions costs neither: what identifies a
    # decrypt is the CLI token immediately followed by `decrypt`, wherever the
    # pair sits, which is what the `index.ts` spelling already did.
    # The name is matched as a WHOLE path component, not by equality. Equality
    # let `./passwd-sso decrypt X` and `/usr/local/bin/passwd-sso decrypt X`
    # through — both of which the regex this scanner replaced did refuse,
    # since it matched the name anywhere in the raw text. That was a
    # regression introduced by this branch, not an inherited gap (round 4,
    # F2). `dist/index.js` is the CLI's real packaged entry point
    # (cli/package.json's bin), so it is recognised alongside the `index.ts`
    # source spelling the /use-credential patterns use; the regex missed that
    # one on main too, and it is a bare decrypt like any other.
    for j, w in enumerate(words[:-1]):
        if words[j + 1] != "decrypt":
            continue
        if w == "passwd-sso" or w.endswith("/passwd-sso"):
            return True
        # `npx tsx path/to/index.ts decrypt …`, a direct `path/to/index.ts
        # decrypt …`, or the built `node path/to/index.js decrypt …`. A whole
        # path component, like the name above: substring containment refused
        # `myindex.jsx-report decrypt X`, a command that invokes nothing
        # (round 5) — the same defect the name match had one revision earlier.
        if w in ("index.ts", "index.js") or w.endswith(("/index.ts", "/index.js")):
            return True
    return False


def _is_clip_sink(seg: Segment) -> bool:
    words = [_strip_quotes(w) for w in seg.words]
    if not words:
        return False
    cw, rest = words[0], words[1:]
    if cw in ("pbcopy", "wl-copy"):
        return not rest
    if cw == "xclip":
        if not rest:
            return True
        return rest in (["-selection", "clipboard"], ["-selection", "primary"], ["-selection", "secondary"])
    if cw == "xsel":
        if len(rest) == 1 and rest[0] in _CLIP_INPUT_FLAGS:
            return True
        if len(rest) == 2 and rest[0] in _CLIP_MODE_FLAGS and rest[1] in _CLIP_INPUT_FLAGS:
            return True
        return False
    return False


def _has_short_flag(words: list[str], letter: str) -> bool:
    """A short option cluster (`-p`, `-rp`, …) carrying `letter`, never a long
    option (`--letter…`, which is a different flag namespace)."""
    for w in words:
        w = _strip_quotes(w)
        if w.startswith("--"):
            continue
        if w.startswith("-") and letter in w[1:]:
            return True
    return False


def _is_dumper(seg: Segment) -> bool | str:
    """Item 2. Returns the reason string, or False."""
    cw = _rule_command_word(seg)
    args = [_strip_quotes(w) for w in seg.words[1:]]
    if cw in _DUMPER_WORDS and _has_short_flag(seg.words[1:], "p"):
        return f"{cw} -p dumps every variable, {CRED_NAME} included"
    if cw in _BARE_DUMPER_WORDS and not seg.words[1:]:
        return f"bare {cw} dumps the environment, {CRED_NAME} included"
    if cw == "compgen" and "-v" in args:
        return "compgen -v lists every variable name and its value"
    return False


def _is_tracer(seg: Segment) -> bool | str:
    """Item 3."""
    cw = _rule_command_word(seg)
    words = seg.words[1:]
    args = [_strip_quotes(w) for w in words]
    if cw == "set":
        if _has_short_flag(words, "x"):
            return "set -x turns on xtrace, which writes the expanded command (and the credential) to stderr"
        if "-o" in args:
            oi = args.index("-o")
            if oi + 1 < len(args) and args[oi + 1] == "xtrace":
                return "set -o xtrace turns on xtrace, which writes the expanded command (and the credential) to stderr"
    if cw in ("bash", "sh") and _has_short_flag(words, "x"):
        return f"{cw} -x turns on xtrace, which writes the expanded command (and the credential) to stderr"
    for name, value in seg.assignments:
        if name == "BASH_XTRACEFD":
            return "BASH_XTRACEFD redirects xtrace output, which includes the expanded command"
    for w in args:
        if w.startswith("BASH_XTRACEFD="):
            return "BASH_XTRACEFD redirects xtrace output, which includes the expanded command"
    return False


# --------------------------------------------------------------------------
# Command-word attribution (the Shape-1 gate)
#
# Every rule below asks "what is this segment's command word?". words[0] is
# that word only for a PLAIN simple command. Two things displace it:
#   * a shell reserved word or grouping token — the segment is a fragment of a
#     compound command this scanner does not model at all (`then echo …`,
#     `do echo …`, `{ echo …`, a `case` arm);
#   * an invocation prefix that execs its operand tail (`command`, `nice`,
#     `timeout 5`, `sudo -u x`, `bash -c`) — finding the real command word
#     would mean modelling each prefix's own option grammar.
# Inside Shape 1 both are REFUSED, not skipped. `env` is the single modelled
# exception, because item 2 of the contract keeps `env VAR=v cmd …` allowed,
# and only its NAME=value operand form is modelled.
# --------------------------------------------------------------------------

_RESERVED_WORDS = {
    "if", "then", "elif", "else", "fi",
    "for", "while", "until", "do", "done",
    "case", "esac", "in", "select", "function", "coproc", "time",
    "{", "}", "!", "[[", "]]", ";;",
}
_PREFIX_WORDS = {
    "command", "builtin", "exec", "eval", "source", ".",
    "env", "nice", "nohup", "stdbuf", "setsid", "ionice", "chrt", "taskset",
    "timeout", "flock", "unbuffer", "script", "watch", "xargs", "parallel",
    "sudo", "doas", "su", "runuser", "systemd-run", "proot", "chroot",
    "strace", "ltrace", "ktrace", "valgrind", "gdb", "lldb",
    "bash", "sh", "zsh", "ksh", "dash", "busybox", "toybox",
}
_DISPLACING_WORDS = _RESERVED_WORDS | _PREFIX_WORDS

# A command word this scanner can attribute: a literal name or path, with no
# expansion in it (`$p "$_CRED"` names a command only bash can resolve).
_PLAIN_CW_RE = re.compile(r"^[A-Za-z0-9_@%+:,./^~-]+$")


def _is_plain_command_word(raw: str, dequoted: str) -> bool:
    if dequoted in _DISPLACING_WORDS:
        return False
    if not _PLAIN_CW_RE.match(dequoted):
        return False
    if "$" in raw or "`" in raw:
        return False
    return True


def _effective_command_word(seg: "Segment"):
    """(name, attributable). `name` is the word that will BE the command;
    `attributable` is False when the scanner cannot say which word that is."""
    words = seg.words
    if not words:
        return None, True  # nothing runs here: assignments / redirection / a nested region
    raw = words[0]
    cw = _strip_quotes(raw)
    if cw == "env" and "$" not in raw and "`" not in raw:
        j = 1
        while j < len(words):
            w = words[j]
            eq = _unquoted_equals_index(w)
            if eq is not None and _NAME_RE.match(w[:eq]):
                j += 1
                continue
            break
        if j >= len(words):
            return cw, True  # `env` with no command operand — item 2's bare-dumper rule owns it
        nxt_raw = words[j]
        nxt = _strip_quotes(nxt_raw)
        if nxt.startswith("-") or not _is_plain_command_word(nxt_raw, nxt):
            return None, False  # an env option (-i, -u, -C, -S) or a displaced operand: not modelled
        return nxt, True
    if not _is_plain_command_word(raw, cw):
        return None, False
    return cw, True


def _rule_command_word(seg: "Segment") -> str:
    """What the item 2-6 rules ask about. Every one of them is REFUSAL-only,
    so when attribution fails we fall back to the literal first word: seeing
    `bash -x` or `xargs … <<<"$_CRED"` there can only add a refusal under its
    own precise message, never remove one. The gate below is the backstop for
    the displaced word no rule names."""
    name, ok = _effective_command_word(seg)
    if ok:
        return name or ""
    return _strip_quotes(seg.words[0]) if seg.words else ""


def _unattributable_reason(seg: "Segment"):
    _name, ok = _effective_command_word(seg)
    if ok:
        return False
    shown = _strip_quotes(seg.words[0]) if seg.words else "?"
    if shown in _RESERVED_WORDS:
        return f"{shown!r} is a shell keyword: this is a fragment of a compound command, not a simple one"
    if shown in _PREFIX_WORDS or shown == "env":
        return f"{shown!r} runs another command given in its operands, which this lint does not resolve"
    return f"{shown!r} is not a plain command name"


_NAMEREF_TARGET_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=" + re.escape(CRED_NAME) + r"$")


def _is_copy(seg: Segment) -> bool | str:
    """Item 4: _CRED copied to another name."""
    for name, value in seg.assignments:
        if name != CRED_NAME and _text_references_cred(value):
            return f"{name}={_strip_quotes(value)!r} copies {CRED_NAME} to another name"
    cw = _rule_command_word(seg)
    args = seg.words[1:]
    dargs = [_strip_quotes(w) for w in args]
    if cw == "read":
        for r in seg.redirs:
            if r.op == "<<<" and _word_references_cred(r.target):
                return f"read …  <<< reads {CRED_NAME} into a new variable"
    if cw == "printf" and "-v" in dargs and any(_word_references_cred(w) for w in args):
        return f"printf -v copies {CRED_NAME} into a new variable"
    if cw in ("declare", "typeset", "local") and _has_short_flag(args, "n"):
        for w in dargs:
            m = _NAMEREF_TARGET_RE.match(w)
            if m:
                return f"{cw} -n {m.group(1)}={CRED_NAME} makes {m.group(1)} a nameref for {CRED_NAME}"
    return False


_BRACE_RE = re.compile(r"\{[^{}]*,[^{}]*\}")


def _brace_word_leaks(seg: Segment) -> bool | str:
    """Item 7."""
    for w in seg.words:
        for m in _BRACE_RE.finditer(w):
            if _text_references_cred(m.group(0)):
                return f"brace expansion {m.group(0)!r} references {CRED_NAME}"
    return False


def _heredoc_leaks(seg: Segment) -> bool | str:
    """Item 5: a `<<`/`<<-` heredoc body referencing _CRED with an unquoted
    delimiter. `<<<` here-strings are a different construct, judged by item 6/4."""
    for hd in seg.heredocs:
        if not hd.quoted and _text_references_cred(hd.body):
            return f"heredoc <<{hd.delim} body references {CRED_NAME}"
    return False


def _printer_leaks(seg: Segment) -> bool | str:
    """Item 6."""
    cw = _rule_command_word(seg)
    if cw in PRINTER_WORDS and _segment_references_cred(seg):
        return f"{cw} references {CRED_NAME} in this segment"
    # 6b: a printer name as a BARE word anywhere in a segment that references
    # the credential. Closes "<unknown prefix> echo $_CRED" without knowing
    # the prefix — the printer is visible in the string whatever runs it.
    if _segment_references_cred(seg):
        for w in seg.words[1:]:
            if "$" in w or "`" in w:
                continue
            if _strip_quotes(w) in PRINTER_WORDS:
                return f"{_strip_quotes(w)} appears as a command name in a segment that references {CRED_NAME}"
    return False


_SHAPE1_RULES = (_is_dumper, _is_tracer, _is_copy, _brace_word_leaks, _heredoc_leaks, _printer_leaks)


def _find_join(segments: list[Segment], target: Segment) -> Segment | None:
    """The segment immediately after `target` in the SAME list, joined by `|`."""
    for i, seg in enumerate(segments):
        if seg is target and i + 1 < len(segments) and segments[i + 1].join_op == "|":
            return segments[i + 1]
    return None


def _find_containing_list(all_lists: list[list[Segment]], target: Segment):
    for lst in all_lists:
        if target in lst:
            return lst
    return None


def _all_lists(segments: list[Segment], acc: list):
    acc.append(segments)
    for seg in segments:
        for _kind, inner in seg.nested:
            _all_lists(inner, acc)


def _is_shape1_capture(segments: list[Segment]) -> bool:
    """An assignment named _CRED whose value is a $( … ) capture that itself
    contains a decrypt occurrence, at any depth (old hook's loosely-anchored
    `_CRED=\\$\\([^)]*DECRYPT_RE`, now asked of parsed structure)."""
    for seg in iter_all_segments(segments):
        for name, _value in seg.assignments:
            if name != CRED_NAME:
                continue
            # The assignment's own nested regions are what its value parsed
            # into; a $( … ) among them holding a decrypt segment is the capture.
            for kind, inner in seg.nested:
                if kind != "cmdsub":
                    continue
                if any(_is_decrypt_segment(s) for s in iter_all_segments(inner)):
                    return True
    return False


def decide(command: str) -> dict:
    segments = parse_command(command)
    all_segs = list(iter_all_segments(segments))
    decrypt_segs = [s for s in all_segs if _is_decrypt_segment(s)]

    if not decrypt_segs:
        # Not a decrypt command at all — this hook has nothing to decide.
        return {"decision": "allow"}

    if len(decrypt_segs) > 1:
        return {
            "decision": "block",
            "message": (
                f"BLOCKED: found {len(decrypt_segs)} decrypt invocations in one command. "
                "This lint can only vouch for a single one — run each in its own Bash call "
                "using a /use-credential pattern."
            ),
        }

    if _is_shape1_capture(segments):
        for seg in all_segs:
            for rule in _SHAPE1_RULES:
                reason = rule(seg)
                if reason:
                    return {
                        "decision": "block",
                        "message": (
                            "BLOCKED: do not print, copy, trace or dump the credential variable "
                            f"({reason}). Pass ${CRED_NAME} directly to the command that consumes it."
                        ),
                    }
        # The inversion: having found no leak it can NAME, the scanner must
        # still be able to say, for every segment, which word runs. A segment
        # it cannot attribute is refused — the rules above were asked of a
        # tree that does not match what bash will execute.
        for seg in all_segs:
            reason = _unattributable_reason(seg)
            if reason:
                return {
                    "decision": "block",
                    "message": (
                        "BLOCKED: part of this command cannot be attributed to a command word "
                        f"({reason}). A {CRED_NAME}=$(… decrypt …) command refuses what it cannot "
                        "read rather than guessing: run the consuming command as a plain simple "
                        "command, or move the compound part into its own Bash call."
                    ),
                }
        return {"decision": "allow"}

    # Shape 2 — the sole decrypt segment piped directly into a documented
    # clipboard sink, in the SAME list it appears in (a pipe does not cross a
    # nesting boundary bash itself would not cross).
    lists: list = []
    _all_lists(segments, lists)
    decrypt_seg = decrypt_segs[0]
    owning_list = _find_containing_list(lists, decrypt_seg)
    if owning_list is not None:
        sink = _find_join(owning_list, decrypt_seg)
        if sink is not None and _is_clip_sink(sink):
            return {"decision": "allow"}

    return {
        "decision": "block",
        "message": (
            "BLOCKED: this decrypt puts its stdout in the conversation. Use a /use-credential "
            f"pattern: capture it with {CRED_NAME}=$(...) and pass ${CRED_NAME} to the consuming "
            "command, or pipe it into a clipboard sink in its documented form (pbcopy, wl-copy, "
            "xclip -selection clipboard, xsel --input). Sink flags that re-emit stdin "
            "(xclip -filter, xsel --output) are refused."
        ),
    }


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) > 1 else "--verdict"
    command = sys.stdin.read()
    if mode == "--segments":
        segments = parse_command(command)
        json.dump({"segments": [s.to_json() for s in segments]}, sys.stdout)
        return 0
    if mode == "--verdict":
        json.dump(decide(command), sys.stdout)
        return 0
    if mode == "--hook":
        # The contract block-bare-decrypt.sh relies on: exit 0 with nothing on
        # stdout is allow; exit 2 with the JSON error object already on stdout
        # is block, ready for the hook to relay verbatim to its own stderr.
        # Any OTHER exit (an uncaught ParseError, any other exception) is left
        # to Python's own default handling — a traceback on stderr and exit 1
        # — which is deliberately neither 0 nor 2: the hook treats that,
        # and nothing else, as "the scanner did not decide" (item 8).
        result = decide(command)
        if result["decision"] == "allow":
            return 0
        json.dump({"error": result["message"]}, sys.stdout)
        return 2
    print(f"unknown mode: {mode}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
