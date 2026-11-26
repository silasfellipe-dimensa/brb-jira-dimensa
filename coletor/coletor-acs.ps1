<#
  Coletor do ACS - roda DENTRO da rede do BRB (Agendador de Tarefas do Windows).

  O que faz, a cada execucao:
    1. pergunta ao servidor (o app na nuvem) se e hora de coletar;
    2. se for, busca no ACS as solicitacoes em andamento e, de cada uma, as
       fases e os pontos de funcao (login Windows do usuario que esta rodando,
       sem senha guardada em lugar nenhum; so rotas de consulta);
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
$TempoLimiteDetalheMs = 20000
# Fases e PF sao 2 consultas por demanda (~1-2s cada par). Passou disto, as
# que faltam ficam para a proxima coleta - a lista em si nunca deixa de ir.
$OrcamentoDetalheSeg = 240
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

# GET de leitura no ACS (mesma conexao direta, com login Windows). 404 vira
# $null; com -Vazio400, um 400 de mensagem vazia tambem (e assim que a rota de
# fases responde para demanda que ainda nao pediu aprovacao de nenhuma fase).
# Outro erro lanca.
function Get-JsonAcs([string]$caminho, [switch]$Vazio400) {
  $pedido = [System.Net.HttpWebRequest]::Create($script:AcsBase + $caminho)
  $pedido.Method = 'GET'
  $pedido.Timeout = $TempoLimiteDetalheMs
  $pedido.ReadWriteTimeout = $TempoLimiteDetalheMs
  $pedido.Accept = '*/*'
  $pedido.Proxy = New-Object System.Net.WebProxy
  $pedido.UseDefaultCredentials = $true
  try {
    $resposta = $pedido.GetResponse()
  } catch [System.Net.WebException] {
    $erro = $_.Exception.Response
    if (-not $erro) { throw }
    $codigo = [int]$erro.StatusCode
    $texto = Read-Resposta $erro
    if ($codigo -eq 404) { return $null }
    if ($Vazio400 -and $codigo -eq 400 -and $texto -match '^\s*\{\s*"Message"\s*:\s*""\s*\}\s*$') { return $null }
    throw "ACS respondeu HTTP $codigo em $caminho"
  }
  return (ConvertFrom-Json -InputObject (Read-Resposta $resposta))
}

# Fases (F1..F7) e contagens de PF de cada demanda, so com rotas de consulta:
#   /Solicitacoes/{n}/fases          historico das fases
#   /Metricas/todos?sq_solicitacao=n contagens de PF e a aprovacao de cada uma
# Ficam de fora matricula e nome de quem cadastrou/aprovou. Se uma demanda
# falhar, ela vai sem detalhe (o servidor mantem o da coleta anterior); se o
# tempo acabar, as que faltam tambem.
function Add-DetalheAcs($lista) {
  if (-not $script:AcsBase) { Write-Registro 'acsUrl fora do formato .../Solicitacoes/...: fases e PF nao serao buscados.'; return }
  $relogio = [System.Diagnostics.Stopwatch]::StartNew()
  $falhas = 0; $semTempo = 0
  foreach ($s in $lista) {
    if ($relogio.Elapsed.TotalSeconds -gt $OrcamentoDetalheSeg) { $semTempo++; continue }
    $n = [string][int64]$s.SQ_SOLICITACAO
    try {
      $fases = Get-JsonAcs "/Solicitacoes/$n/fases" -Vazio400
      $metr = Get-JsonAcs "/Metricas/todos?sq_solicitacao=$n"
      $listaFases = @(@($fases) | Where-Object { $_ } | ForEach-Object {
        [pscustomobject]@{ CD_FASE = $_.CD_FASE; DS_SITUACAO_FASE = $_.DS_SITUACAO_FASE; DT_INCLUSAO_FASE = $_.DT_INCLUSAO_FASE;
          DT_VALIDACAO_FASE = $_.DT_VALIDACAO_FASE; DT_REJEICAO_FASE = $_.DT_REJEICAO_FASE }
      })
      $bloco = @(@($metr) | Where-Object { $_ -and $_.solicitacao -and ([string][int64]$_.solicitacao.nr_solicitacao) -eq $n })
      $listaMetr = @($bloco | ForEach-Object { @($_.metrica) } | Where-Object { $_ } | ForEach-Object {
        [pscustomobject]@{ contagem = $_.contagem; tipo_contagem = $_.tipo_contagem; st_aprovacao = $_.st_aprovacao;
          data_aprovacao = $_.data_aprovacao; nome_documento = $_.nome_documento }
      })
      $coord = if ($bloco.Count) { [string]$bloco[0].solicitacao.coordenacao } else { '' }
      $nomeContrato = if ($bloco.Count) { [string]$bloco[0].solicitacao.contrato } else { '' }
      if ($nomeContrato) { $script:Contratos[$nomeContrato] = 1 + [int]$script:Contratos[$nomeContrato] }
      $s | Add-Member -NotePropertyName FASES -NotePropertyValue $listaFases
      $s | Add-Member -NotePropertyName METRICAS -NotePropertyValue $listaMetr
      $s | Add-Member -NotePropertyName COORDENACAO -NotePropertyValue $coord
    } catch {
      $falhas++
      if ($falhas -le 3) { Write-Registro "Fases/PF da $n nao vieram: $($_.Exception.Message)" }
    }
  }
  $msg = "Fases e PF: $($lista.Count - $falhas - $semTempo) de $($lista.Count) demandas em $([int]$relogio.Elapsed.TotalSeconds)s"
  if ($falhas) { $msg += "; $falhas com erro no ACS" }
  if ($semTempo) { $msg += "; $semTempo ficaram para a proxima (tempo esgotado)" }
  Write-Registro "$msg."
}

# ---- extras: base da tela Producao PF (opcionais; falha aqui nao impede a carga) ----

# Demandas ja implantadas no ultimo ano (para o historico mes a mes), com
# fases e PF. A rota sem /EmAndamento devolve as implantadas.
function Get-ImplantadasAcs {
  $lista = @(Get-JsonAcs "/Solicitacoes/sistemas/$($script:Sigla)")
  $limite = (Get-Date).AddDays(-400)
  $recentes = @($lista | Where-Object {
    $d = [string]$_.DT_IMPLANTACAO
    $_ -and $d -match '^(\d{2})/(\d{2})/(\d{4})' -and (Get-Date -Year ([int]$Matches[3]) -Month ([int]$Matches[2]) -Day ([int]$Matches[1])) -ge $limite
  } | Select-Object -Property SQ_SOLICITACAO, SISSIGLA, DT_IMPLANTACAO, DT_SOLICITACAO, DS_STATUS_SOLICITACAO, ST_SOLICITACAO, DS_RESUMO)
  return ,$recentes
}

# Chamados de sustentacao, um mes por vez (a rota filtra pela abertura), dos
# ultimos 13 meses. So numero, situacao, datas, quantidade, indicador e
# contrato: descricao, solucao e nomes ficam aqui dentro.
function Get-SustentacoesAcs {
  $campos = 'SQ_SUSTENTACAO', 'NO_SISTEMA', 'TP_SITUACAO', 'DT_ABERTURA', 'DT_FINALIZACAO', 'NR_QUANTIDADE', 'SQ_SUSTENTACAO_INDICADOR', 'SQ_CONTRATO'
  $todos = New-Object System.Collections.ArrayList
  $inicio = (Get-Date -Day 1).Date
  for ($i = 12; $i -ge 0; $i--) {
    $mes = $inicio.AddMonths(-$i)
    $fim = $mes.AddMonths(1).AddDays(-1)
    $lote = @(Get-JsonAcs ("/Sustentacoes/{0}/{1}/{2}" -f $script:Sigla, $mes.ToString('yyyy-MM-dd'), $fim.ToString('yyyy-MM-dd')))
    foreach ($c in $lote) { if ($c) { [void]$todos.Add(($c | Select-Object -Property $campos)) } }
  }
  return ,@($todos)
}

# Contrato das demandas (o nome vem das metricas): pesos das fases e a tabela
# de PF por indicador de sustentacao.
function Get-ContratoAcs {
  $nome = $script:Contratos.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1 -ExpandProperty Key
  if (-not $nome) { return $null }
  $c = @(Get-JsonAcs '/Faturamentos/contratos/vigentes') | Where-Object { $_ -and $_.NO_CONTRATO -eq $nome } | Select-Object -First 1
  if (-not $c) { return $null }
  $ind = @(Get-JsonAcs '/SustentacaoIndicador') | Where-Object { $_ -and [string]$_.CD_CONTRATO -eq [string]$c.CD_CONTRATO } |
    Select-Object -Property SQ_SUSTENTACAO_INDICADOR, NR_PF, DS_ATIVIDADE
  $saida = $c | Select-Object -Property SQ_CONTRATO, CD_CONTRATO, NO_CONTRATO, VL_F1, VL_F2, VL_F3, VL_F4, VL_F5, VL_F6, VL_F7
  $saida | Add-Member -NotePropertyName INDICADORES -NotePropertyValue @($ind)
  return $saida
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
  # Raiz do servico (http://.../ACSservice), para as consultas de fases e PF.
  $script:AcsBase = if ($script:AcsUrl -match '^(https?://.+?)/Solicitacoes/') { $Matches[1] } else { $null }
  $script:Sigla = if ($script:AcsUrl -match '/sistemas/([A-Za-z0-9]+)/') { $Matches[1] } else { $null }
  $script:Contratos = @{}
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

try { Add-DetalheAcs $lista } catch { Write-Registro "Fases e PF nao foram buscados: $($_.Exception.Message)" }

# Extras da Producao PF. Cada um e independente: se falhar, a carga vai sem ele.
$extras = ''
if ($script:AcsBase -and $script:Sigla) {
  try {
    $impl = Get-ImplantadasAcs
    Add-DetalheAcs $impl
    $extras += ',"implantadas":' + (ConvertTo-Json -InputObject @($impl) -Depth 5 -Compress)
  } catch { Write-Registro "Implantadas nao foram buscadas: $($_.Exception.Message)" }
  try {
    $sust = Get-SustentacoesAcs
    $extras += ',"sustentacoes":' + (ConvertTo-Json -InputObject @($sust) -Depth 3 -Compress)
    Write-Registro "Sustentacao: $($sust.Count) chamados dos ultimos 13 meses."
  } catch { Write-Registro "Sustentacao nao foi buscada: $($_.Exception.Message)" }
  try {
    $contrato = Get-ContratoAcs
    if ($contrato) { $extras += ',"contrato":' + (ConvertTo-Json -InputObject $contrato -Depth 4 -Compress) }
    else { Write-Registro 'Contrato nao encontrado entre os vigentes.' }
  } catch { Write-Registro "Contrato nao foi buscado: $($_.Exception.Message)" }
}

try {
  $corpo = '{"solicitacoes":' + (ConvertTo-Json -InputObject @($lista) -Depth 5 -Compress) + $extras + '}'
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
