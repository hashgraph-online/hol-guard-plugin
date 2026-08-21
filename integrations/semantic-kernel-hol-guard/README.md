# HOL Guard for Microsoft Semantic Kernel

`HolGuard.SemanticKernel` is a thin `IFunctionInvocationFilter` that sends every Semantic Kernel function invocation through the local HOL Guard decision boundary before the function executes.

It does not duplicate policy inside Semantic Kernel and does not require HOL Guard Cloud. The adapter uses HOL Guard's generic local hook envelope and maps the result back into Semantic Kernel's native filter pipeline.

## Execution boundary

- `allow`: calls `next(context)` and the function executes normally.
- `deny`: does not call `next(context)` and returns a structured `HolGuardBlockedResult`.
- `review`: asks an optional host-provided `IHolGuardApprovalHandler`; without an approval handler, review fails closed.
- unavailable, timeout, malformed, or ambiguous Guard response: fails closed before function execution.

HOL Guard receives the function name plus `KernelArguments` as tool input, with `framework: semantic-kernel`. The CLI call is bounded by a five-second timeout by default.

## Usage

The package currently lives in this repository as a source integration artifact. It is not yet published to NuGet.

```csharp
using HolGuard.SemanticKernel;
using Microsoft.SemanticKernel;

var builder = Kernel.CreateBuilder();
builder.AddHolGuard(new HolGuardOptions
{
    Workspace = Directory.GetCurrentDirectory(),
});

var kernel = builder.Build();
```

`hol-guard` must be installed and available on `PATH` (or configure `HolGuardOptions.Executable`).

For applications that support human approval, implement `IHolGuardApprovalHandler` and pass it to `AddHolGuard`. A Guard `review` decision only proceeds when that handler explicitly approves the invocation.

## Validation

The test project exercises the real Semantic Kernel invocation pipeline and proves that denied, review-without-approval, and Guard-unavailable calls never execute the underlying function, while allowed and explicitly approved calls do.

```bash
dotnet test integrations/semantic-kernel-hol-guard/tests/HolGuard.SemanticKernel.Tests/HolGuard.SemanticKernel.Tests.csproj
```

The integration targets the current Semantic Kernel `IFunctionInvocationFilter` contract and is pinned to `Microsoft.SemanticKernel` 1.80.0 for reproducibility.
