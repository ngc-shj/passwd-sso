################################################################################
# Audit anchor S3 prefix — the one place its rule is enforced in Terraform.
#
# Provider-less so `terraform test` can exercise the rule without AWS
# credentials. The root passes its prefix through this module and reads it
# back from `prefix`; the bucket policy and the publisher's task env both take
# the output, so no unvalidated copy of the value reaches either.
#
# The rule: one or more `/`-separated segments of [A-Za-z0-9._-], none `.` or
# `..`. A `*` or `?` would widen every bucket-policy statement built on the
# prefix; a leading, trailing or doubled `/` would make the documented keys
# differ from the ones the publisher builds. src/lib/env-schema.ts
# (isValidAnchorS3Prefix) states the same rule for a non-empty prefix; both are
# driven by prefix-vectors.json.
#
# Two parts because regex() is RE2: there is no lookahead, and a lookahead
# pattern under can() refuses every value rather than failing loudly.
################################################################################

variable "prefix" {
  type        = string
  description = "S3 key prefix the audit anchors are written under, without leading or trailing '/'."

  validation {
    condition = (
      can(regex("^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$", var.prefix)) &&
      alltrue([for s in split("/", var.prefix) : s != "." && s != ".."])
    )
    error_message = "prefix must be one or more '/'-separated segments of [A-Za-z0-9._-], none '.' or '..' (no '*', '?', or leading, trailing or doubled '/')."
  }
}

output "prefix" {
  value       = var.prefix
  description = "The validated prefix."
}
