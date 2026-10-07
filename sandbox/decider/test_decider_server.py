"""Unit tests for oasis-decider's request validation and HTTP handling.

No model and no torch: a fake decider stands in for Laya.
Run:  cd sandbox/decider && python3 -m unittest test_decider_server.py
"""

import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import decider_server as ds

VERDICT = {"verdict": {"type": "choice", "instructions": "Pick one.",
                       "criteria": {"allow": "fine", "deny": "harmful"}}}


class Validate(unittest.TestCase):
    def ok(self, body):
        return ds.validate(body)

    def bad(self, body, fragment):
        with self.assertRaises(ds.BadRequest) as cm:
            ds.validate(body)
        self.assertIn(fragment, str(cm.exception))

    def test_string_and_object_state_accepted(self):
        self.ok({"state": "x", "questions": VERDICT})
        self.ok({"state": {"tool": "exec"}, "questions": VERDICT})

    def test_state_rules(self):
        self.bad({"state": " ", "questions": VERDICT}, "empty")
        self.bad({"state": 3, "questions": VERDICT}, "string or an object")
        self.bad({"state": "x" * (ds.MAX_STATE_CHARS + 1), "questions": VERDICT}, "longer")

    def test_question_rules(self):
        self.bad({"state": "x", "questions": {}}, "non-empty")
        self.bad({"state": "x", "questions": {"q": {"type": "free", "instructions": "?"}}}, "type")
        self.bad({"state": "x", "questions": {"q": {"type": "noul"}}}, "instructions")
        self.bad({"state": "x", "questions": {"q": {"type": "choice", "instructions": "?",
                                                    "criteria": {"only": "one"}}}}, "2..")
        many = {f"o{i}": "d" for i in range(ds.MAX_CHOICE_OPTIONS + 1)}
        self.bad({"state": "x", "questions": {"q": {"type": "choice", "instructions": "?",
                                                    "criteria": many}}}, "2..")
        self.bad({"state": "x", "questions": {"q": {"type": "score", "instructions": "?",
                                                    "criteria": ["one"]}}}, "at least 2")
        too_many = {f"q{i}": {"type": "noul", "instructions": "?"} for i in range(ds.MAX_QUESTIONS + 1)}
        self.bad({"state": "x", "questions": too_many}, "at most")


class Unwrap(unittest.TestCase):
    def test_laya_wrapper_and_bare_answers(self):
        self.assertEqual(ds.unwrap({"model": "m", "answers": {"q": 1}, "usage": {"n": 2}}), ({"q": 1}, {"n": 2}))
        self.assertEqual(ds.unwrap({"q": {"type": "noul"}}), ({"q": {"type": "noul"}}, None))


class FakeDecider:
    name, revision = "fake", "0" * 40

    def __init__(self, fail=False):
        self.fail, self.calls = fail, []

    def predict(self, state, questions):
        if self.fail:
            raise RuntimeError("boom")
        self.calls.append((state, questions))
        return ds.unwrap({"model": "laya-rl-agent", "usage": {"input_tokens": 1},
                          "answers": {qid: {"type": q["type"]} for qid, q in questions.items()}})


class Http(unittest.TestCase):
    def serve(self, decider):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), ds.make_handler(decider))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        return f"http://127.0.0.1:{srv.server_address[1]}"

    def post(self, base, body, raw=None):
        data = raw if raw is not None else json.dumps(body).encode()
        req = urllib.request.Request(f"{base}/v1/decide", data=data, method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_healthz(self):
        base = self.serve(FakeDecider())
        with urllib.request.urlopen(f"{base}/healthz", timeout=5) as r:
            self.assertEqual(json.loads(r.read())["model"], "fake")

    def test_decide_round_trip(self):
        fake = FakeDecider()
        code, out = self.post(self.serve(fake), {"state": "s", "questions": VERDICT})
        self.assertEqual(code, 200)
        self.assertEqual(out["answers"], {"verdict": {"type": "choice"}})
        self.assertEqual(len(fake.calls), 1)

    def test_invalid_request_never_reaches_model(self):
        fake = FakeDecider()
        base = self.serve(fake)
        self.assertEqual(self.post(base, {"state": "s", "questions": {}})[0], 400)
        self.assertEqual(self.post(base, None, raw=b"{not json")[0], 400)
        self.assertEqual(fake.calls, [])

    def test_oversized_body_rejected(self):
        code, _ = self.post(self.serve(FakeDecider()), None, raw=b" " * (ds.MAX_BODY_BYTES + 1))
        self.assertEqual(code, 413)

    def test_model_error_is_500_not_crash(self):
        base = self.serve(FakeDecider(fail=True))
        code, out = self.post(base, {"state": "s", "questions": VERDICT})
        self.assertEqual(code, 500)
        self.assertIn("RuntimeError", out["error"])
        with urllib.request.urlopen(f"{base}/healthz", timeout=5) as r:
            self.assertEqual(r.status, 200)


if __name__ == "__main__":
    unittest.main()
