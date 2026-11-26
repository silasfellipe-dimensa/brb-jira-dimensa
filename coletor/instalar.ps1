<#
  Instala o coletor do ACS nesta maquina (precisa estar na rede do BRB).

  Uso:
    .\instalar.ps1 -AppUrl https://endereco-do-app.vercel.app

  O que faz:
    1. guarda o endereco do app e o do ACS em %LOCALAPPDATA%\brb-jira-dimensa;
    2. gera o segredo do coletor (ou reaproveita o que ja existe), guarda
       cifrado pelo Windows (DPAPI) e mostra UMA vez na tela, para voce colar
       na variavel ACS_COLETOR_SEGREDO do app (Vercel);
    3. copia o coletor para a mesma pasta e cria a tarefa agendada, que roda a
       cada 5 minutos enquanto voce estiver logado (pode estar com a tela
       bloqueada). Na maioria das vezes a tarefa so pergunta ao servidor "devo
       coletar?" e termina; a coleta mesmo acontece as 8h dos dias uteis e
       quando alguem clica em Atualizar na tela.

  Parametros:
    -NovoSegredo        troca o segredo (depois e preciso atualizar a Vercel)
    -IntervaloMinutos   de quanto em quanto tempo a tarefa roda (padrao 5)
    -Desinstalar        remove a tarefa agendada e apaga o segredo

  Arquivo so com caracteres ASCII de proposito (PowerShell 5.1 sem BOM).
#>
param(
  [string]$AppUrl,
  [string]$AcsUrl = 'http://acs.brb.com.br/ACSservice/Solicitacoes/sistemas/TTB/EmAndamento',
  [int]$IntervaloMinutos = 5,
  [switch]$NovoSegredo,
  [switch]$Desinstalar
)

$ErrorActionPreference = 'Stop'
$NomeTarefa = 'BRB Jira Dimensa - Coletor ACS'
$PastaDados = Join-Path $env:LOCALAPPDATA 'brb-jira-dimensa'
$ArquivoConfig = Join-Path $PastaDados 'coletor.json'
$ArquivoSegredo = Join-Path $PastaDados 'coletor-segredo.dpapi'
$ScriptInstalado = Join-Path $PastaDados 'coletor-acs.ps1'

if ($Desinstalar) {
  if (Get-ScheduledTask -TaskName $NomeTarefa -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $NomeTarefa -Confirm:$false
    Write-Host "Tarefa '$NomeTarefa' removida."
  } else {
    Write-Host 'A tarefa agendada nao existia.'
  }
  if (Test-Path $ArquivoSegredo) { Remove-Item $ArquivoSegredo -Force; Write-Host 'Segredo apagado.' }
  Write-Host 'Lembre de apagar a variavel ACS_COLETOR_SEGREDO na Vercel se o coletor nao for mais usado.'
  exit 0
}

if (-not $AppUrl) { throw 'Informe o endereco do app: .\instalar.ps1 -AppUrl https://...' }
$AppUrl = $AppUrl.Trim().TrimEnd('/')
if ($AppUrl -notmatch '^https://[^/\s]+$') { throw 'O -AppUrl precisa ser https://dominio (sem caminho depois).' }
if ($IntervaloMinutos -lt 1 -or $IntervaloMinutos -gt 60) { throw '-IntervaloMinutos deve ficar entre 1 e 60.' }

New-Item -ItemType Directory -Force -Path $PastaDados | Out-Null

# 1. configuracao (sem segredo nenhum dentro)
$config = ConvertTo-Json -InputObject @{ appUrl = $AppUrl; acsUrl = $AcsUrl }
Set-Content -Path $ArquivoConfig -Value $config -Encoding UTF8

# 2. segredo: 32 bytes aleatorios, cifrados pelo Windows para ESTE usuario
if ($NovoSegredo -or -not (Test-Path $ArquivoSegredo)) {
  $bytes = New-Object byte[] 32
  $gerador = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $gerador.GetBytes($bytes) } finally { $gerador.Dispose() }
  $segredo = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  $cifrado = ConvertTo-SecureString -String $segredo -AsPlainText -Force | ConvertFrom-SecureString
  Set-Content -Path $ArquivoSegredo -Value $cifrado -Encoding ASCII
  Write-Host ''
  Write-Host '================================================================'
  Write-Host ' SEGREDO DO COLETOR (aparece so agora; nao fica em texto no disco)'
  Write-Host ''
  Write-Host "   $segredo"
  Write-Host ''
  Write-Host ' Cole este valor na Vercel, em Settings > Environment Variables,'
  Write-Host ' com o nome ACS_COLETOR_SEGREDO, e faca um novo deploy.'
  Write-Host ' Nao mande por e-mail nem chat, e nao guarde em arquivo.'
  Write-Host '================================================================'
  Write-Host ''
  $segredo = $null
} else {
  Write-Host 'Segredo ja existia: mantido (use -NovoSegredo para trocar).'
}

# 3. o coletor fica numa pasta que nao depende de onde esta o repositorio
Copy-Item -Path (Join-Path $PSScriptRoot 'coletor-acs.ps1') -Destination $ScriptInstalado -Force

# 4. tarefa agendada. "conhost --headless" roda o PowerShell sem abrir janela.
#    LogonType Interactive = roda so com voce logado, com o SEU login Windows:
#    e ele que o ACS aceita, e nenhuma senha fica guardada na tarefa.
$argumentos = '--headless powershell.exe -NoProfile -NonInteractive -File "' + $ScriptInstalado + '"'
$acao = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $argumentos
$gatilho = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes $IntervaloMinutos)
$ajustes = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$quem = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $NomeTarefa -Action $acao -Trigger $gatilho -Settings $ajustes -Principal $quem -Force `
  -Description 'Busca as solicitacoes em andamento no ACS e envia para o app brb-jira-dimensa.' | Out-Null

Write-Host "Tarefa '$NomeTarefa' criada: roda a cada $IntervaloMinutos minuto(s)."
Write-Host "Pasta do coletor: $PastaDados  (log: coletor.log)"
Write-Host ''
Write-Host 'Para testar agora (depois de configurar a Vercel e rodar o supabase-acs.sql):'
Write-Host "  powershell -File `"$ScriptInstalado`" -Forcar"
