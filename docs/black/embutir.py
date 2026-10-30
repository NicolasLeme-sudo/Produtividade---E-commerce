"""Gera a apresentação da Missão Black em um arquivo único, que abre sem internet e sem a pasta img/.
Uso: python docs/black/embutir.py "C:/Users/<você>/Downloads/Missao_Black_Lideranca.html"
Embute regras-black.js e as imagens de img/ dentro do HTML."""
import base64, pathlib, re, sys

aqui = pathlib.Path(__file__).parent
s = (aqui / 'apresentacao.html').read_text(encoding='utf-8')
regras = (aqui.parent.parent / 'regras-black.js').read_text(encoding='utf-8')
s = s.replace('<script src="../../regras-black.js"></script>', '<script>\n' + regras + '\n</script>')

def uri(m):
    dados = (aqui / 'img' / m.group(1)).read_bytes()
    return 'data:image/png;base64,' + base64.b64encode(dados).decode()

s = re.sub(r'img/([\w-]+\.png)', uri, s)
saida = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'Missao_Black_Lideranca.html')
saida.write_text(s, encoding='utf-8')
print('ok', saida, round(len(s) / 1024), 'KB')
