from __future__ import annotations

from superai_node.core.utils.sanitization import is_sensitive_field


def test_sensitive_field_vocabulary_is_case_insensitive() -> None:
    assert is_sensitive_field("Authorization")
    assert is_sensitive_field("raw_payload")
    assert not is_sensitive_field("command")
