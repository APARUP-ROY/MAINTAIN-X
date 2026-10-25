function Set-ProcessSecret {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Prompt,
        [switch]$Required
    )

    $secureValue = Read-Host $Prompt -AsSecureString
    if ($secureValue.Length -eq 0) {
        if ($Required) {
            throw "$Name is required to accept sensor readings."
        }
        Remove-Item "Env:$Name" -ErrorAction SilentlyContinue
        return
    }

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try {
        Set-Item "Env:$Name" ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $secureValue.Dispose()
    }
}

$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Stop'
try {
    Set-ProcessSecret -Name 'MAINTAINX_INGEST_TOKEN' -Prompt 'Optional sensor-ingest bearer token (press Enter to leave device ingestion disabled)'
    Set-ProcessSecret -Name 'GROQ_API_KEY' -Prompt 'Newly rotated Groq API key (press Enter to disable assistant)'
    if (-not $env:GROQ_MODEL) {
        $env:GROQ_MODEL = 'openai/gpt-oss-120b'
    }

    python -m uvicorn maintain_x.live_api:app --host 127.0.0.1 --port 8000
}
finally {
    Remove-Item Env:MAINTAINX_INGEST_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:GROQ_API_KEY -ErrorAction SilentlyContinue
    $ErrorActionPreference = $previousErrorAction
}