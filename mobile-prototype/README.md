# DISTRILOG Mobile — protótipo de todos os setores conectado ao backend real

**Interface móvel própria**, baseada no arquivo HTML do protótipo de fluxos enviado
pelo operador. Mantém os mesmos padrões visuais: verde-limão, fundo escuro,
cards, indicadores e navegação inferior. Não carrega o DISTRILOG Web em WebView.
O WebView exibe **somente os recursos locais do APK**; uma ponte Android (OkHttp)
envia requisições HTTPS JSON à API real do Render.

## Instalação e conexão

Este APK de **homologação** usa assinatura debug. Instale em Android 7+.
Na primeira abertura, informe a URL HTTPS raiz do **seu serviço Render** e
entre com usuário e senha reais (mesma autenticação do app Web).
O identificador do app é
`com.distribox.distrilogmobile.prototype`, permitindo instalar em paralelo ao
APK anterior. Nunca incorpore tokens pessoais ou senhas no APK.

## O que foi conectado

- Login, sessão por cookie HttpOnly, alteração inicial de senha, idioma e saída;
- Filas de Recebimento, Qualidade, Processamento, Etiquetagem, Estocagem,
  Costura/despacho, Cadastro e Entrada;
- Consulta de cards reais, grade, status, histórico, endereços físicos,
  posições e conteúdo real dos endereços;
- Leitor QR e código de barras pela câmera: identificar Rack/ID e pesquisar;
- Recebimento: marcar chegada, salvar volumes, avarias, peças e 10%,
  controlar cronômetro, declarar volumes após tiragem e concluir
  com as validações do servidor;
- WMS: alocar em posições reais RM/QA/PR/ET/EC conforme regras originais
  (com contagem de caixas pretas em ET/EC);
- Qualidade: iniciar inspeção 1/2, parâmetros CD01/CD02, Costura,
  Desenvolvimento, atribuições, cronômetro, resultados e conclusão,
  além de transferência da segunda inspeção ao Processamento;
- Processamento: iniciar Triagem, contagem cega, pausa/retomada,
  conclusão e escolha de Etiquetagem/Estocagem; Entrada final;
- Etiquetagem/Estocagem: iniciar controles, assumir execução,
  apontar produção, pausa/retomada, conferências e conclusão.

**As permissões, saldos, mudanças de etapa e regras de WMS são aplicados
pelo backend.** O app não mantém um segundo banco, não simula cards,
não cria uma fila offline de operações e não salva dados sem confirmação.
Todos os passos definitivos solicitam confirmação.

## Limitações importantes para homologar

- **Não homologado em aparelho físico**: o APK só é publicado após compilar
  e conferir a assinatura no GitHub Actions. Testar cada fluxo com cards de
  homologação antes de usar em operação real.
- Não implementa criação de cards, transferência global entre endereços,
  upload de fotos ou chat no APK. Esses fluxos continuam no Web,
  até serem implementados com contratos próprios.
- Não garante paridade de todas as telas com o Web; opera o subconjunto
  de endpoints indicado acima. O protótipo antigo simulava passos que não
  tinham correspondente 1:1 no backend atual.
- A leitura de um Rack não pressupõe etiqueta padronizada: IDs
  numéricos e RACK-1234 resolvem por card; outros códigos servem
  apenas como pesquisa. Nenhuma leitura envia uma operação.
- As contagens cegas não exibem quantidades previstas para o operador.
- Exige internet e HTTPS. Um timeout pode ocorrer **depois** do servidor
  registrar uma ação: reabra o Card antes de tentar novamente.
- Os APKs debug são assinados com certificado de teste do runner: uma
  reinstalação por novo runner pode exigir desinstalar a versão anterior,
  perdendo apenas as preferências locais do APK (não os dados do WMS).
- O app armazena apenas o endereço HTTPS e metadados não secretos do
  usuário. A sessão é gerenciada pelo CookieManager privado do Android.
- O servidor determina as permissões: administradores podem visualizar
  filas diversas, mas as ações operacionais podem estar disponíveis
  apenas ao perfil responsável pelo setor.
- Não faz atualização automática do próprio APK.

## Build reproduzível

No GitHub, executar `Stock 3D...` **não** compila este APK. O workflow
exato é **DISTRILOG Mobile - Prototipo Integrado (APK)**. O arquivo será
publicado nos artifacts da execução como
`DISTRILOG-Mobile-PROTOTIPO-INTEGRADO.apk`.

O código Android fica isolado em `mobile-prototype/` e não altera o
backend, a branch principal nem o Render de produção.

## Versão piloto 1.1.0 — organização de espaço

No Android, a aba **Atividades** permite Abertura de espaço e Devolução ao porta-paletes, com fluxo guiado em 4 etapas: atividade → rua/marca → cronômetro persistente → quantidade e unidade obrigatórias. O registro é compartilhado com o DISTRILOG Web via `/api/space-activities` e armazenado no Supabase; não altera o saldo nem transfere fisicamente posições no WMS. O Card passa a separar Operar/Endereços/Grade/Histórico e as operações de Recebimento, Qualidade, Triagem e ET/EC exibem etapas em sequência, com navegação fixa na parte inferior. Os fluxos completos exigem homologação física. Não foram incluídos novos processos de Separação ou Expedição antes da definição das regras operacionais.

O pipeline desta versão gera um APK de homologação e publica uma **GitHub Release prerelease** com link direto de instalação (sem precisar baixar o ZIP de Artifacts). A assinatura debug do runner pode mudar entre builds: se o Android disser "app não instalado", desinstale apenas a versão anterior do APK protótipo e instale novamente (dados WMS permanecem no servidor).
