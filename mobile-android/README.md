# DISTRILOG Mobile — APK Android de homologação

Aplicativo Android nativo enxuto para validar login e fluxos reais do DISTRILOG hospedado no Render.
Usa WebView autenticada para as telas operacionais (não duplica regras do WMS); oferece leitor de QR nativo,
com cópia do código para colar no formulário. Não envia o QR automaticamente nem movimenta mercadoria.
Informe a URL HTTPS do Render no primeiro acesso. HTTPS obrigatório; cookies do backend são usados na WebView.
Atenção: utiliza ambiente real quando apontado para o endereço de produção. Teste com cards de homologação.
É uma **versão Android operacional enxuta**, não a compilação integral do protótipo Expo V06
(os modos simulados não foram incluídos). APK de debug é assinado apenas para testes, não para Google Play.
Branch de compilação isolada, sem alterações no backend e na branch main.

## Atualização interna (em desenvolvimento)

Ao iniciar, o Android consulta por HTTPS o manifesto em `mobile-android/update.json` na branch de homologação. Quando `versionCode` for maior que o instalado, oferece download HTTPS, valida SHA-256 e abre o instalador Android usando FileProvider. A confirmação do sistema operacional continua necessária.

**Publicação:** só publicar um manifesto de atualização depois de hospedar um APK com URL HTTPS direta e estável e calcular o SHA-256 exato. O JSON exige `versionCode` (inteiro), `versionName` (texto), `apkUrl` (HTTPS), `sha256` (64 hex) e `mandatory` (booleano). Sem manifesto publicado, o app continua operando normalmente.

**Bloqueio de distribuição:** o workflow atual usa assinatura DEBUG, que pode mudar entre builds no GitHub Actions. APKs com chaves diferentes NÃO atualizam uns aos outros. Antes de usar atualização real, configurar keystore de assinatura persistente em GitHub Secrets e alterar o workflow para produzir instaladores com a mesma chave. Não publicar um APK de atualização assinado com chave diferente. O modo obrigatório ainda não impede todas as operações quando a verificação falha; não utilizá-lo como controle de acesso até implementar política robusta no backend.
