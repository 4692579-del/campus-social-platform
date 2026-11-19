# Local, read-only quota diagnostic. Never print or save credentials.
# Use a stable token without forcing a refresh; never reset API quotas.
$ErrorActionPreference = 'Stop'
$quotaAppId = $null
$quotaSecretSecure = $null
$quotaSecret = $null
$quotaSecretPointer = [IntPtr]::Zero
$quotaTokenResult = $null
$quotaTokenBody = $null
$quotaToken = $null
$quotaUrl = $null
$quotaStage = 'input'

function Write-QuotaApiError($stage, $code) {
    $hints = @{
        '40013' = 'Check the mini-program AppID.'
        '40125' = 'Check the AppSecret for this mini-program.'
        '40164' = 'Check the server IP whitelist in mini-program developer settings.'
        '40001' = 'The access token was rejected.'
        '40014' = 'The access token is invalid.'
        '42001' = 'The access token has expired.'
        '45009' = 'This API has reached its call limit.'
        '76021' = 'The queried API path was not found.'
        '76022' = 'This token cannot query the requested API.'
    }
    $safeCode = if ([string]$code -match '^-?\d{1,10}$') { [string]$code } else { 'UNKNOWN' }
    $hint = if ($hints.ContainsKey($safeCode)) { $hints[$safeCode] } else { 'WeChat rejected this request. Report only stage and errcode.' }
    [ordered]@{ stage = $stage; errcode = $safeCode; hint = $hint } | ConvertTo-Json
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $quotaAppId = (Read-Host 'Mini-program AppID').Trim()
    $quotaSecretSecure = Read-Host 'AppSecret (hidden; paste then press Enter)' -AsSecureString
    if ($quotaAppId -notmatch '^wx[0-9a-fA-F]{16}$' -or $quotaSecretSecure.Length -eq 0) {
        Write-QuotaApiError 'input' '40013'
        return
    }
    $quotaSecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($quotaSecretSecure)
    $quotaSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($quotaSecretPointer).Trim()
    $quotaTokenBody = @{ grant_type = 'client_credential'; appid = $quotaAppId; secret = $quotaSecret; force_refresh = $false } | ConvertTo-Json -Compress
    $quotaStage = 'token'
    $quotaTokenResult = Invoke-RestMethod -Method Post -Uri 'https://api.weixin.qq.com/cgi-bin/stable_token' -ContentType 'application/json; charset=utf-8' -Body $quotaTokenBody -TimeoutSec 30
    if (-not $quotaTokenResult.access_token -or ($quotaTokenResult.errcode -and $quotaTokenResult.errcode -ne 0)) {
        Write-QuotaApiError 'token' $quotaTokenResult.errcode
        return
    }
    $quotaToken = [string]$quotaTokenResult.access_token
    $quotaUrl = 'https://api.weixin.qq.com/cgi-bin/openapi/quota/get?access_token=' + [Uri]::EscapeDataString($quotaToken)
    $quotaStage = 'quota'
    $quotaResponse = Invoke-RestMethod -Method Post -Uri $quotaUrl -ContentType 'application/json; charset=utf-8' -Body '{"cgi_path":"/wxa/msg_sec_check"}' -TimeoutSec 30
    if ($null -eq $quotaResponse.errcode -or $quotaResponse.errcode -ne 0) {
        Write-QuotaApiError 'quota' $quotaResponse.errcode
        return
    }
    # Whitelist output fields: never echo raw token responses or error details.
    [ordered]@{
        stage = 'quota'
        errcode = 0
        cgi_path = '/wxa/msg_sec_check'
        quota = [ordered]@{
            daily_limit = $quotaResponse.quota.daily_limit
            used = $quotaResponse.quota.used
            remain = $quotaResponse.quota.remain
        }
        rate_limit = [ordered]@{
            call_count = $quotaResponse.rate_limit.call_count
            refresh_second = $quotaResponse.rate_limit.refresh_second
        }
    } | ConvertTo-Json -Depth 4
} catch {
    # Exception messages can include request URLs/tokens, so never print $_.
    [ordered]@{ stage = $quotaStage; error = 'LOCAL_OR_NETWORK_ERROR'; hint = 'Check your connection and inputs, then retry. No credentials are included in this output.' } | ConvertTo-Json
} finally {
    if ($quotaSecretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($quotaSecretPointer) }
    if ($quotaSecretSecure) { $quotaSecretSecure.Dispose() }
    $quotaSecret = $null
    $quotaSecretSecure = $null
    $quotaTokenBody = $null
    $quotaTokenResult = $null
    $quotaToken = $null
    $quotaUrl = $null
    $quotaResponse = $null
}
