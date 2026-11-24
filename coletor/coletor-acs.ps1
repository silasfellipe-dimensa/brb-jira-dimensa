<#
  Coletor do ACS - roda DENTRO da rede do BRB (Agendador de Tarefas do Windows).

  O que faz, a cada execucao:
    1. pergunta ao servidor (o app na nuvem) se e hora de coletar;
    2. se for, busca no ACS as solicitacoes em andamento (login Windows do
       usuario que esta rodando, sem senha guardada em lugar nenhum);
    3. manda a lista para o servidor - ou o motivo da falha, que aparece na tela.

  Seguranca:
    - o segredo fica em disco cifrado pelo Windows (DPAPI): so este usuario,
      nesta maquina, consegue ler;
    - o segredo nunca trafega: cada pedido leva uma assinatura (HMAC-SHA256)
      que vale so para aquele corpo e por 5 minutos;
    - a matricula do gestor (NR_GESTOR_NEGOCIO) e descartada aqui, antes de
      sair da rede do banco.

  Instalacao: coletor\instalar.ps1.
  Teste manual: .\coletor-acs.ps1 -Forcar   (coleta sem perguntar ao servidor)

  Arquivo so com caracteres ASCII de proposito: o PowerShell 5.1 le .ps1 sem
  BOM como ANSI e estragaria os acentos.
#>
param(
  [switch]$Forcar
)

$ErrorActionPreference = 'Stop'
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$PastaDados = if ($env:COLETOR_ACS_PASTA) { $env:COLETOR_ACS_PASTA } else { Join-Path $env:LOCALAPPDATA 'brb-jira-dimensa' }
$ArquivoConfig = Join-Path $PastaDados 'coletor.json'
$ArquivoSegredo = Join-Path $PastaDados 'coletor-segredo.dpapi'
$ArquivoLog = Join-Path $PastaDados 'coletor.log'
$TempoLimiteMs = 60000
$CamposAcs = 'SQ_SOLICITACAO', 'SISSIGLA', 'DS_STATUS_SOLICITACAO', 'ST_SOLICITACAO', 'DS_RESUMO',
  'DT_IMPLANTACAO', 'DT_SOLICITACAO', 'DT_PREVISAO_INICIO', 'DT_PREVISAO_TERMINO', 'NO_GESTOR_NEGOCIO'

function Write-Registro([string]$texto) {
  $linha = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $texto
  Write-Host $linha
  try {
    Add-Content -Path $ArquivoLog -Value $linha -Encoding UTF8
    # O log nao cresce para sempre: passou de 2000 linhas, ficam as ultimas 1000.
    $linhas = @(Get-Content -Path $ArquivoLog -Encoding UTF8)
    if ($linhas.Count -gt 2000) { Set-Content -Path $ArquivoLog -Value $linhas[-1000..-1] -Encoding UTF8 }
  } catch { }
}

function Read-Segredo {
  $cifrado = (Get-Content -Path $ArquivoSegredo -Raw).Trim()
  $seguro = ConvertTo-SecureString -String $cifrado
  $ponteiro = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)
  try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ponteiro) }
  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ponteiro) }
}

function Get-Assinatura([string]$segredo, [string]$timestamp, [string]$metodo, [string]$caminho, [byte[]]$corpo) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $prefixo = $utf8.GetBytes("$timestamp`n$metodo`n$caminho`n")
  $tudo = New-Object byte[] ($prefixo.Length + $corpo.Length)
  [System.Array]::Copy($prefixo, 0, $tudo, 0, $prefixo.Length)
  if ($corpo.Length -gt 0) { [System.Array]::Copy($corpo, 0, $tudo, $prefixo.Length, $corpo.Length) }
  $hmac = New-Object System.Security.Cryptography.HMACSHA256
  try {
    $hmac.Key = $utf8.GetBytes($segredo)
    return (($hmac.ComputeHash($tudo) | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally { $hmac.Dispose() }
}

function Read-Resposta($resposta) {
  $leitor = New-Object System.IO.StreamReader($resposta.GetResponseStream(), (New-Object System.Text.UTF8Encoding($false)))
  try { return $leitor.ReadToEnd() } finally { $leitor.Dispose(); $resposta.Close() }
}

# Pedido assinado ao servidor. Devolve @{ Status; Corpo } mesmo quando o
# servidor responde erro (4xx/5xx); so lanca se nao houve resposta nenhuma.
function Invoke-Servidor([string]$metodo, [string]$caminho, [string]$corpoTexto) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $corpo = if ($corpoTexto) { $utf8.GetBytes($corpoTexto) } else { New-Object byte[] 0 }
  $timestamp = [string][int64]([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalSeconds

  $pedido = [System.Net.HttpWebRequest]::Create($script:AppUrl + $caminho)
  $pedido.Method = $metodo
  $pedido.Timeout = $TempoLimiteMs
  $pedido.ReadWriteTimeout = $TempoLimiteMs
  $pedido.UserAgent = 'coletor-acs'
  $pedido.Accept = 'application/json'
  $pedido.AllowAutoRedirect = $false
  # Saida para a internet: pelo proxy do banco, com o login Windows.
  if ($pedido.Proxy) { $pedido.Proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials }
  $pedido.Headers.Add('X-Coletor-Timestamp', $timestamp)
  $pedido.Headers.Add('X-Coletor-Assinatura', (Get-Assinatura $script:Segredo $timestamp $metodo $caminho $corpo))
  if ($corpo.Length -gt 0) {
    $pedido.ContentType = 'application/json; charset=utf-8'
    $pedido.ContentLength = $corpo.Length
    $saida = $pedido.GetRequestStream()
    try { $saida.Write($corpo, 0, $corpo.Length) } finally { $saida.Dispose() }
  }
  try {
    $resposta = $pedido.GetResponse()
  } catch [System.Net.WebException] {
    if (-not $_.Exception.Response) { throw }
    $resposta = $_.Exception.Response
  }
  $status = [int]$resposta.StatusCode
  return @{ Status = $status; Corpo = (Read-Resposta $resposta) }
}

# Busca no ACS com o login Windows de quem esta rodando (Negotiate/Kerberos),
# sem proxy: o ACS e interno. Devolve a lista ja sem a matricula do gestor.
function Get-SolicitacoesAcs {
  $pedido = [System.Net.HttpWebRequest]::Create($script:AcsUrl)
  $pedido.Method = 'GET'
  $pedido.Timeout = $TempoLimiteMs
  $pedido.ReadWriteTimeout = $TempoLimiteMs
  $pedido.Accept = '*/*'
  $pedido.Proxy = New-Object System.Net.WebProxy   # proxy vazio = conexao direta
  $pedido.UseDefaultCredentials = $true
  try {
    $resposta = $pedido.GetResponse()
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) {
      $codigo = [int]$_.Exception.Response.StatusCode
      $_.Exception.Response.Close()
      throw "O ACS respondeu HTTP $codigo."
    }
    throw "Nao consegui falar com o ACS: $($_.Exception.Message)"
  }
  $texto = Read-Resposta $resposta
  try { $dados = ConvertFrom-Json -InputObject $texto } catch { throw 'O ACS respondeu algo que nao e JSON.' }
  $lista = @($dados)
  if ($lista.Count -eq 0) { throw 'O ACS devolveu uma lista vazia.' }
  if (-not ($lista[0].PSObject.Properties.Name -contains 'SQ_SOLICITACAO')) { throw 'O ACS respondeu um JSON em formato inesperado.' }
  return @($lista | Select-Object -Property $CamposAcs)
}

function Send-Falha([string]$motivo) {
  try {
    $corpo = ConvertTo-Json -InputObject @{ erro = $motivo } -Compress
    $r = Invoke-Servidor 'POST' '/api/acs/coletor/carga' $corpo
    Write-Registro "Falha avisada ao servidor (HTTP $($r.Status))."
  } catch {
    Write-Registro "Nao consegui avisar a falha ao servidor: $($_.Exception.Message)"
  }
}

# ---------------------------------------------------------------------------

try {
  if (-not (Test-Path $ArquivoConfig) -or -not (Test-Path $ArquivoSegredo)) {
    throw "Coletor nao instalado: rode coletor\instalar.ps1 (faltam arquivos em $PastaDados)."
  }
  $config = Get-Content -Path $ArquivoConfig -Raw | ConvertFrom-Json
  $script:AppUrl = ([string]$config.appUrl).TrimEnd('/')
  $script:AcsUrl = [string]$config.acsUrl
  # O servidor so por HTTPS (http so para teste na propria maquina).
  if ($script:AppUrl -notmatch '^https://' -and $script:AppUrl -notmatch '^http://(127\.0\.0\.1|localhost)(:\d+)?$') {
    throw 'appUrl precisa comecar com https://'
  }
  $script:Segredo = Read-Segredo
} catch {
  Write-Registro "ERRO de configuracao: $($_.Exception.Message)"
  exit 2
}

try {
  if (-not $Forcar) {
    $tarefa = Invoke-Servidor 'GET' '/api/acs/coletor/tarefa' $null
    if ($tarefa.Status -ne 200) {
      Write-Registro "O servidor respondeu HTTP $($tarefa.Status) a pergunta 'devo coletar?': $($tarefa.Corpo)"
      exit 1
    }
    $resposta = $tarefa.Corpo | ConvertFrom-Json
    if (-not $resposta.coletar) { exit 0 }   # nada a fazer: nem registra, para o log nao encher
    Write-Registro "Coletando (motivo: $($resposta.motivo))."
  } else {
    Write-Registro 'Coletando (forcado pela linha de comando).'
  }
} catch {
  Write-Registro "Nao consegui falar com o servidor: $($_.Exception.Message)"
  exit 1
}

try {
  $lista = Get-SolicitacoesAcs
} catch {
  $motivo = if ($_.Exception.Message) { $_.Exception.Message } else { [string]$_ }
  Write-Registro "Falha no ACS: $motivo"
  Send-Falha $motivo
  exit 1
}

try {
  $corpo = '{"solicitacoes":' + (ConvertTo-Json -InputObject @($lista) -Depth 3 -Compress) + '}'
  $r = Invoke-Servidor 'POST' '/api/acs/coletor/carga' $corpo
  if ($r.Status -eq 200) {
    Write-Registro "Carga enviada: $($lista.Count) solicitacoes."
    exit 0
  }
  Write-Registro "O servidor recusou a carga (HTTP $($r.Status)): $($r.Corpo)"
  exit 1
} catch {
  Write-Registro "Nao consegui enviar a carga: $($_.Exception.Message)"
  exit 1
}
