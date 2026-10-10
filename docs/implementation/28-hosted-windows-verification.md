# 28 - Hosted Windows verification (CA-ISSUE-050)

Status: reviewed candidate, not accepted or delivered. Nothing below is a passing result; gates are requirements.

## 1. Observed (source 17ea, same runtime and tests as c7402cc)

Advisory `windows-tests` job, run 38011515598: 38 failures, two causes.

1. **36 identity path failures.** `os.tmpdir()` returns `C:/Users/RUNNER~1/AppData/Local/Temp` (8.3 alias) while native `realpath` resolves `runneradmin`. [`assertPlainEntry`](../../src/auth/filePrivacy.ts) compares `realpath(path)` with `resolve(path)` and throws `resolves elsewhere`. The refusal is intentional privacy: it is not weakened.
2. **2 timeouts.** In [checkpointContinuation.test.ts](../../tests/integration/checkpointContinuation.test.ts) the "dirty start, staged change, moved base" and "unsupported pins" tests each built three real Git fixtures under the default 5000 ms and both timed out. The file's `T = 120_000` covers other process cases; it is a test allowance, not a product timeout or SLO.

## 2. Test change (this candidate)

Each group is now `it.each`, one fixture per case, six independent tests. Same `refusal` helper, so exact refusal code, zero worker calls, no POST, empty tool log and gate state are still asserted.

- dirty `worktree_dirty`; staged `worktree_dirty`; moved base `pin_mismatch`
- mismatched Vitest hash, mismatched Node hash, missing Prettier: each `pin_mismatch`

Only these six carry `GIT_CASE_MS = 30_000` (finite real-Git budget). No global timeout, skip, removed assertion, production or API bound change.

## 3. Recommended workflow patch (root applies; `.github` is outside the worker profile)

In [verify.yml](../../.github/workflows/verify.yml) job `windows-tests`:

- Delete `continue-on-error: true` and the advisory comment above it, so Windows failures fail the workflow.
- After `actions/setup-node@v4`, before `npm ci`, add:

```yaml
      - name: Canonicalize hosted temp directory
        shell: pwsh
        run: |
          $p = node -e "const fs=require('node:fs'),os=require('node:os');console.log(fs.realpathSync.native(os.tmpdir()))"
          if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($p)) { exit 1 }
          $p = $p.Trim()
          "TEMP=$p" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
          "TMP=$p" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
```

Notes: the path comes only from the existing temp directory via Node native realpath, never from event, browser, worker or prompt input. Do not use `Resolve-Path` or `DirectoryInfo.FullName`; they can keep the alias. pwsh `utf8` is BOM-less. The existing directory must exist.

Not proposed: suppressing failures, ACL repair, widening privacy acceptance, a wholesale temp-test refactor, a new dependency or another runner.

## 4. Gates (future, reported with real output)

1. Focused actual-process run of the six refusal tests.
2. `npm run format`, `npm run lint`, docs checks.
3. Exact temporary active-branch CI at the exact candidate source: both `windows-tests` and `verify` jobs succeed. Overall workflow status alone is insufficient.
4. If another hosted issue remains, preserve the output and diagnose it; do not grow timeouts blindly.

## 5. Boundaries

Root publishes only reviewed source after independent checks. No license, credential, deployment or visibility operation.
