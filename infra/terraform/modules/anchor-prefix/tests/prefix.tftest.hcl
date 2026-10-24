# Runs pinned to ../prefix-vectors.json: one run per entry whose `terraform`
# verdict is not n/a, in file order, with that verdict. A static vitest test
# (src/__tests__/infra/anchor-prefix-vectors.test.ts) fails when the two drift,
# and the terraform CI job requires the passed count to equal the entry count.

run "deny_empty" {
  command = plan

  variables {
    prefix = ""
  }

  expect_failures = [var.prefix]
}

run "allow_audit-anchors" {
  command = plan

  variables {
    prefix = "audit-anchors"
  }

  assert {
    condition     = output.prefix == "audit-anchors"
    error_message = "an allowed prefix must pass through unchanged"
  }
}

run "allow_a" {
  command = plan

  variables {
    prefix = "a"
  }

  assert {
    condition     = output.prefix == "a"
    error_message = "an allowed prefix must pass through unchanged"
  }
}

run "allow_a_slash_b" {
  command = plan

  variables {
    prefix = "a/b"
  }

  assert {
    condition     = output.prefix == "a/b"
    error_message = "an allowed prefix must pass through unchanged"
  }
}

run "allow_adotb" {
  command = plan

  variables {
    prefix = "a.b"
  }

  assert {
    condition     = output.prefix == "a.b"
    error_message = "an allowed prefix must pass through unchanged"
  }
}

run "allow_dota" {
  command = plan

  variables {
    prefix = ".a"
  }

  assert {
    condition     = output.prefix == ".a"
    error_message = "an allowed prefix must pass through unchanged"
  }
}

run "allow_dotdota" {
  command = plan

  variables {
    prefix = "..a"
  }

  assert {
    condition     = output.prefix == "..a"
    error_message = "an allowed prefix must pass through unchanged"
  }
}

run "allow_adotdotb" {
  command = plan

  variables {
    prefix = "a..b"
  }

  assert {
    condition     = output.prefix == "a..b"
    error_message = "an allowed prefix must pass through unchanged"
  }
}

run "allow_a_slash_dotdotb" {
  command = plan

  variables {
    prefix = "a/..b"
  }

  assert {
    condition     = output.prefix == "a/..b"
    error_message = "an allowed prefix must pass through unchanged"
  }
}

run "deny_star" {
  command = plan

  variables {
    prefix = "*"
  }

  expect_failures = [var.prefix]
}

run "deny_qmark" {
  command = plan

  variables {
    prefix = "?"
  }

  expect_failures = [var.prefix]
}

run "deny__slash_a" {
  command = plan

  variables {
    prefix = "/a"
  }

  expect_failures = [var.prefix]
}

run "deny_a_slash_" {
  command = plan

  variables {
    prefix = "a/"
  }

  expect_failures = [var.prefix]
}

run "deny_a_slash__slash_b" {
  command = plan

  variables {
    prefix = "a//b"
  }

  expect_failures = [var.prefix]
}

run "deny_dot" {
  command = plan

  variables {
    prefix = "."
  }

  expect_failures = [var.prefix]
}

run "deny_dotdot" {
  command = plan

  variables {
    prefix = ".."
  }

  expect_failures = [var.prefix]
}

run "deny_a_slash_dotdot_slash_b" {
  command = plan

  variables {
    prefix = "a/../b"
  }

  expect_failures = [var.prefix]
}

run "deny_a_slash_dot_slash_b" {
  command = plan

  variables {
    prefix = "a/./b"
  }

  expect_failures = [var.prefix]
}
