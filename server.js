const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*", // Permite que o jogo no Itch.io se conecte sem problemas de CORS
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));

const bancoPalavras = {
    "animais": ["cachorro", "gato", "elefante", "girafa", "leao", "macaco", "jacare", "tartaruga"],
    "frutas": ["banana", "maca", "morango", "uva", "melancia", "abacaxi", "laranja", "manga"],
    "objetos": ["cadeira", "mesa", "celular", "caneta", "relogio", "computador", "garrafa", "chave"]
};

let salasAtivas = {};

function obterJogadoresDaSala(salaId) {
    const conexoes = io.sockets.adapter.rooms.get(salaId);
    return conexoes ? Array.from(conexoes) : [];
}

function atualizarPlacarGeral(salaId) {
    const infoSala = salasAtivas[salaId];
    if (!infoSala) return;

    const jogadores = obterJogadoresDaSala(salaId);
    let listaPlacar = jogadores.map(id => {
        const socketJogador = io.sockets.sockets.get(id);
        return {
            id: id,
            nome: socketJogador ? socketJogador.meuNome : "Jogador",
            pontos: infoSala.pontos[id] || 0,
            eDesenhista: id === infoSala.desenhistaId
        };
    });

    listaPlacar.sort((a, b) => b.pontos - a.pontos);
    io.to(salaId).emit('atualizar_placar_visual', listaPlacar);
}

function verificarVencedor(salaId) {
    const infoSala = salasAtivas[salaId];
    if (!infoSala) return false;

    const jogadores = obterJogadoresDaSala(salaId);
    let vencedor = null;

    for (const id of jogadores) {
        if ((infoSala.pontos[id] || 0) >= 100) {
            const socketJogador = io.sockets.sockets.get(id);
            vencedor = socketJogador ? socketJogador.meuNome : "Alguém";
            break;
        }
    }

    if (vencedor) {
        clearInterval(infoSala.intervalo);
        io.to(salaId).emit('mensagem_sistema', `👑🏆🎉 FIM DE JOGO! ${vencedor.toUpperCase()} ATINGIU 100 PONTOS E É O GRANDE CAMPEÃO! 🎉🏆👑`);
        io.to(salaId).emit('fim_de_jogo');
        
        infoSala.status = "espera";
        infoSala.desenhistaId = null;
        for (const id of jogadores) {
            infoSala.pontos[id] = 0;
        }
        atualizarPlacarGeral(salaId);
        return true;
    }
    return false;
}

function passarVezProximo(salaId) {
    const infoSala = salasAtivas[salaId];
    if (!infoSala) return;

    clearInterval(infoSala.intervalo);

    if (verificarVencedor(salaId)) return;

    const jogadores = obterJogadoresDaSala(salaId);
    if (jogadores.length === 0) {
        delete salasAtivas[salaId];
        return;
    }

    let proximoIndex = 0;
    if (infoSala.desenhistaId) {
        let indexAtual = jogadores.indexOf(infoSala.desenhistaId);
        if (indexAtual !== -1) {
            proximoIndex = (indexAtual + 1) % jogadores.length;
        }
    }
    
    const novoDesenhistaId = jogadores[proximoIndex];
    const novoDesenhistaSocket = io.sockets.sockets.get(novoDesenhistaId);
    
    const categories = Object.keys(bancoPalavras);
    const categoriaSorteada = categories[Math.floor(Math.random() * categories.length)];
    const lista = bancoPalavras[categoriaSorteada];
    
    const embaralhadas = [...lista].sort(() => 0.5 - Math.random());
    const opcao1 = embaralhadas[0];
    const opcao2 = embaralhadas[1];

    infoSala.categoria = categoriaSorteada;
    infoSala.palavraSecreta = ""; 
    infoSala.opcoes = [opcao1, opcao2];
    infoSala.desenhistaId = novoDesenhistaId;
    infoSala.desenhistaNome = novoDesenhistaSocket ? novoDesenhistaSocket.meuNome : "Jogador";
    infoSala.status = "escolhendo";
    infoSala.jaAcertaramNessaRodada = 0;

    io.to(salaId).emit('mensagem_sistema', `--- PRÓXIMA RODADA ---`);
    io.to(salaId).emit('mensagem_sistema', `🖌️ Vez de ${infoSala.desenhistaNome}. Aguardando escolha...`);
    io.to(salaId).emit('limpar_lousa_ouvinte');

    atualizarPlacarGeral(salaId);

    for (const id of jogadores) {
        const clienteSocket = io.sockets.sockets.get(id);
        if (clienteSocket) {
            if (id === infoSala.desenhistaId) {
                clienteSocket.emit('fase_escolha', { categoria: categoriaSorteada, opcoes: [opcao1, opcao2], tempo: 6 });
            } else {
                clienteSocket.emit('definir_papeis', { eDesenhista: false, categoria: categoriaSorteada, status: "escolhendo" });
            }
        }
    }

    let tempoEscolha = 6;
    infoSala.intervalo = setInterval(() => {
        tempoEscolha--;
        io.to(salaId).emit('tempo_atualizado', tempoEscolha);

        if (tempoEscolha <= 0) {
            clearInterval(infoSala.intervalo);
            io.to(salaId).emit('mensagem_sistema', `⏰ ${infoSala.desenhistaNome} não escolheu a tempo! Passando a vez...`);
            passarVezProximo(salaId);
        }
    }, 1000);
}

function iniciarTempoDesenho(salaId) {
    const infoSala = salasAtivas[salaId];
    if (!infoSala) return;

    clearInterval(infoSala.intervalo);
    infoSala.status = "jogando";

    let tempoJogo = 50; 
    io.to(salaId).emit('tempo_jogo_iniciado', tempoJogo);

    infoSala.intervalo = setInterval(() => {
        tempoJogo--;
        io.to(salaId).emit('tempo_atualizado', tempoJogo);

        if (tempoJogo <= 0) {
            clearInterval(infoSala.intervalo);
            io.to(salaId).emit('mensagem_sistema', `⏰ Fim do tempo! A palavra era ${infoSala.palavraSecreta.toUpperCase()}.`);
            passarVezProximo(salaId);
        }
    }, 1000);
}

io.on('connection', (socket) => {
    
    // SISTEMA DE BUSCA DE PARTIDAS ALEATÓRIAS
    socket.on('buscar_partida_aleatoria', () => {
        let salaAlvo = null;

        for (let idSala in salasAtivas) {
            if (idSala.startsWith('SALA-PUBLICA-')) {
                const qtdJogadores = obterJogadoresDaSala(idSala).length;
                if (salasAtivas[idSala].status === "espera" && qtdJogadores < 6) {
                    salaAlvo = idSala;
                    break;
                }
            }
        }

        if (!salaAlvo) {
            salaAlvo = "SALA-PUBLICA-" + Math.floor(1000 + Math.random() * 9000);
            salasAtivas[salaAlvo] = { 
                desenhistaId: null, 
                intervalo: null, 
                status: "espera", 
                donoId: "SISTEMA_PUBLICO",
                pontos: {}, 
                jaAcertaramNessaRodada: 0
            };
        }

        socket.emit('sala_aleatoria_encontrada', { sala: salaAlvo });
    });

    socket.on('entrar_sala', (dados) => {
        socket.join(dados.sala);
        socket.meuNome = dados.nome; 
        socket.salaAtual = dados.sala;

        if (!salasAtivas[dados.sala]) {
            salasAtivas[dados.sala] = { 
                desenhistaId: null, 
                intervalo: null, 
                status: "espera", 
                donoId: socket.id,
                pontos: {}, 
                jaAcertaramNessaRodada: 0
            };
            socket.emit('voce_e_o_dono');
            socket.emit('mensagem_sistema', `👑 Você é o dono da sala! Aguarde os jogadores e clique em Começar.`);
        } else {
            io.to(dados.sala).emit('mensagem_sistema', `${dados.nome} entrou no jogo! 🎯`);
            
            const infoSalaPublica = salasAtivas[dados.sala];
            if (dados.sala.startsWith('SALA-PUBLICA-') && infoSalaPublica.status === "espera") {
                const totalJogadores = obterJogadoresDaSala(dados.sala).length;

                if (totalJogadores >= 6) {
                    if (infoSalaPublica.timeoutInicio) clearTimeout(infoSalaPublica.timeoutInicio);
                    if (infoSalaPublica.intervaloAviso) clearInterval(infoSalaPublica.intervaloAviso);
                    
                    io.to(dados.sala).emit('mensagem_sistema', `🔥 Sala cheia (6/6)! A partida vai começar agora!`);
                    passarVezProximo(dados.sala);
                } 
                else if (totalJogadores === 2) {
                    let tempoRestante = 60;
                    io.to(dados.sala).emit('mensagem_sistema', `🎮 Jogadores suficientes conectados! A partida começará em ${tempoRestante} segundos ou quando atingir 6 jogadores...`);
                    
                    infoSalaPublica.intervaloAviso = setInterval(() => {
                        tempoRestante -= 15;
                        if (tempoRestante > 0) {
                            io.to(dados.sala).emit('mensagem_sistema', `⏳ A partida pública começará em ${tempoRestante} segundos...`);
                        }
                    }, 15000);

                    infoSalaPublica.timeoutInicio = setTimeout(() => {
                        clearInterval(infoSalaPublica.intervaloAviso);
                        if (salasAtivas[dados.sala] && salasAtivas[dados.sala].status === "espera") {
                            const jogadoresAtuais = obterJogadoresDaSala(dados.sala);
                            if (jogadoresAtuais.length >= 2) {
                                io.to(dados.sala).emit('mensagem_sistema', `🚀 O tempo limite acabou! Partida pública iniciada com ${jogadoresAtuais.length} jogadores.`);
                                passarVezProximo(dados.sala);
                            }
                        }
                    }, 60000);
                }
            }
        }

        if (salasAtivas[dados.sala].pontos[socket.id] === undefined) {
            salasAtivas[dados.sala].pontos[socket.id] = 0;
        }

        const infoSala = salasAtivas[dados.sala];
        if(infoSala.status === "jogando") {
            socket.emit('definir_papeis', { eDesenhista: false, categoria: infoSala.categoria, status: "jogando" });
        } else if(infoSala.status === "escolhendo") {
            socket.emit('definir_papeis', { eDesenhista: false, categoria: infoSala.categoria, status: "escolhendo" });
        } else {
            socket.emit('definir_papeis', { eDesenhista: false, categoria: "", status: "espera" });
        }

        atualizarPlacarGeral(dados.sala);
    });

    socket.on('conectar_voz_sala', (dados) => {
        socket.to(dados.sala).emit('novo_participante_voz', { id: socket.id });
    });

    socket.on('enviar_oferta_voz', (dados) => {
        io.to(dados.para).emit('receber_oferta_voz', { oferta: dados.oferta, de: socket.id });
    });

    socket.on('enviar_resposta_voz', (dados) => {
        io.to(dados.para).emit('receber_resposta_voz', { resposta: dados.resposta, de: socket.id });
    });

    socket.on('enviar_ice_candidate', (dados) => {
        io.to(dados.para).emit('receber_ice_candidate', { candidate: dados.candidate, de: socket.id });
    });

    socket.on('iniciar_jogo_dono', (dados) => {
        const infoSala = salasAtivas[dados.sala];
        if (infoSala && socket.id === infoSala.donoId && infoSala.status === "espera") {
            const jogadores = obterJogadoresDaSala(dados.sala);
            jogadores.forEach(id => infoSala.pontos[id] = 0);
            
            io.to(dados.sala).emit('mensagem_sistema', `🚀 O Dono da sala iniciou a partida!`);
            passarVezProximo(dados.sala);
        }
    });

    socket.on('palavra_escolhida', (dados) => {
        const infoSala = salasAtivas[dados.sala];
        if (infoSala && socket.id === infoSala.desenhistaId && infoSala.status === "escolhendo") {
            infoSala.palavraSecreta = dados.palavra.toLowerCase();
            
            socket.emit('definir_papeis', { eDesenhista: true, categoria: infoSala.categoria, palavra: infoSala.palavraSecreta, status: "jogando" });
            socket.to(dados.sala).emit('definir_papeis', { eDesenhista: false, categoria: infoSala.categoria, status: "jogando" });
            
            io.to(dados.sala).emit('mensagem_sistema', `🎨 O desenhista escolheu a palavra! Valendo 50 segundos!`);
            socket.emit('mensagem_sistema', `🤫 SUA PALAVRA SECRETA É: ${infoSala.palavraSecreta.toUpperCase()}`);

            iniciarTempoDesenho(dados.sala);
            atualizarPlacarGeral(dados.sala);
        }
    });

    socket.on('enviar_palpite', (dados) => {
        const infoSala = salasAtivas[dados.sala];
        if (!infoSala || infoSala.status !== "jogando") return;

        if (socket.id === infoSala.desenhistaId) {
            socket.emit('mensagem_sistema', `❌ Você é o desenhista, não pode palpitar!`);
            return;
        }
        
        const palpiteLimpo = dados.mensagem.trim().toLowerCase();

        if (palpiteLimpo === infoSala.palavraSecreta) {
            let pontosGanhos = infoSala.jaAcertaramNessaRodada === 0 ? 15 : 10; 
            infoSala.pontos[socket.id] = (infoSala.pontos[socket.id] || 0) + pontosGanhos;
            
            if (infoSala.desenhistaId) {
                infoSala.pontos[infoSala.desenhistaId] = (infoSala.pontos[infoSala.desenhistaId] || 0) + 5;
            }

            infoSala.jaAcertaramNessaRodada++;
            io.to(dados.sala).emit('mensagem_sistema', `🎉💥 ${dados.nome} ACERTOU (+${pontosGanhos} pts)! A palavra era ${infoSala.palavraSecreta.toUpperCase()}!`);
            passarVezProximo(dados.sala);
        } else {
            io.to(dados.sala).emit('receber_palpite', dados);
        }
    });

    socket.on('desenhando', (dados) => {
        const infoSala = salasAtivas[dados.sala];
        if (infoSala && socket.id === infoSala.desenhistaId && infoSala.status === "jogando") {
            socket.to(dados.sala).emit('desenhar_ouvinte', dados);
        }
    });

    socket.on('limpar_lousa', (dados) => {
        const infoSala = salasAtivas[dados.sala];
        if (infoSala && socket.id === infoSala.desenhistaId && infoSala.status === "jogando") {
            io.to(dados.sala).emit('limpar_lousa_ouvinte');
        }
    });

    socket.on('disconnect', () => {
        if (socket.salaAtual) {
            io.to(socket.salaAtual).emit('usuario_saiu_voz', { id: socket.id });
            const salaId = socket.salaAtual;
            const infoSala = salasAtivas[salaId];

            if (infoSala) {
                if (infoSala.desenhistaId === socket.id) {
                    io.to(salaId).emit('mensagem_sistema', `🔌 O desenhista desconectou!`);
                    passarVezProximo(salaId);
                } else {
                    atualizarPlacarGeral(salaId);
                }

                if (obterJogadoresDaSala(salaId).length === 0) {
                    if (infoSala.intervalo) clearInterval(infoSala.intervalo);
                    if (infoSala.timeoutInicio) clearTimeout(infoSala.timeoutInicio);
                    if (infoSala.intervaloAviso) clearInterval(infoSala.intervaloAviso);
                    delete salasAtivas[salaId];
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Gatilho Rápido BR rodando na porta ${PORT}`);
});