# Robô de envio — telão Black Friday

Vigia a pasta de Downloads e envia ao banco do Produtividade os relatórios do WMS
(`Exportacao_<número>.tsv`), sem abrir o site. Reconhece o relatório pelas colunas.
Usa o próprio `ingest.js` do site, então os números são os mesmos do Abastecimento.

## Instalar (uma vez)
```
git clone https://github.com/NicolasLeme-sudo/Produtividade---E-commerce.git
cd Produtividade---E-commerce\robo
npm.cmd install
copy .env.exemplo .env
notepad .env
```
Preencha `PROD_EMAIL`, `PROD_SENHA` e `PASTA`. O `.env` nunca vai para o GitHub.

## Usar
- Teste sem gravar nada: `npm.cmd run teste -- C:\Users\SEU_USUARIO\Downloads\Exportacao_123.tsv`
- Ligar o vigia: `npm.cmd start` (Ctrl+C para parar)

Arquivos enviados com sucesso vão para `Downloads\telao-enviados`. O histórico fica em `robo.log`.

## Reconhecidos
Separação Analítica, Conferência Analítica, Conferência Colmeia, Kardex e Acompanhamento OP.
Itens de NF de Saída: reconhecido, envio na fase 2 (Report E-commerce).
Não abra e salve o TSV no Excel antes: isso corrompe os acentos do cabeçalho.
