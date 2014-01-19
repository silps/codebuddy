/* Add modules */
var fs = require('fs'),
    app = require('../app'),
    db = require('./database'),
    utils = require('./utils'),
    uuid = require('node-uuid'),
    config = require('./config'),
    express = require('express'),
    ss = require('socket.io-stream'),
    io = require('socket.io').listen(app.server),
    passportSocketIo = require('passport.socketio'),

io.set('log level', 1);
io.set('authorization', passportSocketIo.authorize({
    cookieParser: express.cookieParser,
    key: 'connect.sid',
    secret: config.session_secret,
    store: app.SessionStore,
    fail: function (data, accept) {
        console.log("ERROR", "scoket data:", data);
        accept(null, false);
    },
    success: function (data, accept) {
        //console.log("INFO", "scoket:", data);
        accept(null, true);
    }
}));

/* Online users */
var onlineUsers = { 'study': {}, 'coding': {}, 'sumorobot': {} };
var sockUsers = [];
var eSocks = [];

/* User initiated socket connection */
io.sockets.on('connection', function(socket) {
	
	/* User connected to socketio */
	console.log("INFO", "socket connection established");
	console.log("INFO", "socket user:", socket.handshake.user.email);
	socket.heartbeatTimeout = 5000;
	sockUsers[socket.handshake.user.email] = socket;

	/* Subscribing and unsubscribing to rooms */
	socket.on('subscribe', function(room) {
		socket.join(room);
		/* Delete user from from every room, dont know where he was :P */
		delete onlineUsers['study'][socket.handshake.user.email];
		delete onlineUsers['coding'][socket.handshake.user.email];
		delete onlineUsers['sumorobot'][socket.handshake.user.email];
		/* Add the user to the room he/she is now */
		onlineUsers[room][socket.handshake.user.email] = {
			name: socket.handshake.user.name,
			email: socket.handshake.user.email,
			profile: {
				points: socket.handshake.user.profile.points,
				mugshot: socket.handshake.user.profile.mugshot,
				description: socket.handshake.user.profile.description
			}
		};
		/* Update the online users for all users in every room */
		io.sockets.to('study').emit('users', onlineUsers['study']);
		io.sockets.to('coding').emit('users', onlineUsers['coding']);
		io.sockets.to('sumorobot').emit('users', onlineUsers['sumorobot']);

		console.log("INFO", "online users:", onlineUsers);
	});

	/* User sends ping */
	socket.on('ping', function() {
		console.log("INFO", "ping received from user:", socket.handshake.user.email);
	});

	/* User asks for someones code */
	socket.on('get-code', function(room, userEmail) {
		console.log("INFO", "get user code:", userEmail);
		socket.emit('receive-code', onlineUsers[room][userEmail].code);
	});

	/* User shares his/her code */
	socket.on('share-code', function(room, code) {
		console.log("INFO", "share user code:", socket.handshake.user.email);
		socket.broadcast.to(room).emit('receive-code', code);
	});

	/* User shares his/her chat */
	socket.on('share-chat', function(room, chat) {
		console.log("INFO", "user chat:", socket.handshake.user.email);
		io.sockets.to(room).emit('receive-chat', socket.handshake.user.name, chat);
	});

	/* User asks for a task */
	socket.on('get-task', function() {
		console.log("INFO", "get task:", socket.handshake.user.email);
		socket.emit('receive-task', utils.getTask());
	});

	/* User verifies a task */
	socket.on('verify-task', function(room, code) {
		console.log("INFO", "verifiying task:", code.replace(/\s+/g, ''));
		/* Save the users code */
		onlineUsers[room][socket.handshake.user.email].code = code;
		var prev_task = utils.getTask();
		/* Check if task has been completed */
		if (utils.taskComplete(code)) {
			/* Send the winner to everyone in the room and update their task */
			io.sockets.to(room).emit('receive-task-verification', socket.handshake.user.name, prev_task.points);
			io.sockets.to(room).emit('receive-task', utils.getTask());
			/* Update user points in his session */
			onlineUsers[room][socket.handshake.user.email].profile.points += prev_task.points;
			/* Update the online users for all users */
			io.sockets.to(room).emit('users', onlineUsers[room]);
		}
	});

    socket.on('sendCurrentUser', function (data) {
        var cuser = {
            email: socket.handshake.user.email,
            name: socket.handshake.user.name,
            profile: {
                points: socket.handshake.user.profile.points,
                mugshot: socket.handshake.user.profile.mugshot,
                description: socket.handshake.user.profile.description
            }
        }
        socket.emit('currentUser', {user: cuser});
    });

    socket.on('sendExclusiveInvite', function (data) {
        try {
            var newSockAdd = uuid.v1();
            eSocks.push(newSockAdd);
            sockUsers[data.email].emit('exclusiveInvite', {email: socket.handshake.user.email, newSockAdd: newSockAdd});
        } catch (error) {
            console.log("WARN", "error", error);
        }

    });

    socket.on('eInviteResponse', function (data) {
        if (data.accepted) {
            //start listening on new connection
            //only if(data.newSockadd is in esocket)
            //also check if its already in Ecode withsomeone
            startECodeServer(data.newSockAdd,data.email,socket.handshake.user.email);
            sockUsers[data.email].emit("initiateECode", {on: data.newSockAdd});
            socket.emit("initiateECode", {on: data.newSockAdd});
        } else {
            //delete newsockadd
            sockUsers[data.email].emit("rejectedECodeInvitation", {});
        }
    });

	/* User send sumorobot code */
	socket.on('send-sumorobot-code', function(code) {
		console.log("INFO", "sumorobot code:", code);
		/* Add sumorobot libraries */
		code = "#include <Servo.h>\n#include <Sumorobot.h>\n" + code;
		/* Write the program to the file */
		fs.writeFile("public/compiler/main.ino", code, function(err) {
			if(err) console.log("ERROR", "failed to save sumorobot code:", err);
			else console.log("INFO", "sumorobot code was saved");
		});
		/* Compile the program */
		var child = exec("cd public/compiler && make all && make upload",
			function (error, stdout, stderr) {
				console.log("INFO", "stdout:", stdout);
				console.log("INFO", "stderr:", stderr);
				if (error !== null) console.log("INFO", "exec error:", error);
			}
		);
	});

	/* To stream mugshot to the server */
	ss(socket).on('mugshot', function(stream, meta) {
		console.log("INFO", "incoming stream size:", meta.size, meta.name)
		/* Drop the stream if the file is too large max 100KB allowed */
		if (meta.size > 100000) return;
		stream.pipe(fs.createWriteStream("public/images/" + meta.name));
		// Send progress back
		ss(socket).emit('data', "Mugshot uploaded, click save to update");
	});

	/* User disconnected from socket */
	socket.on('disconnect', function() {
		console.log("INFO", "socket user disconnected:", socket.handshake.user.email);
		/* Save user points to his/her session */
		if (onlineUsers['coding'][socket.handshake.user.email]) {
			var sessionID = socket.handshake.sessionID;
			var points = onlineUsers['coding'][socket.handshake.user.email].profile.points;
			app.SessionStore.get(sessionID, function(err, session) {
				if (!err && session) {
					session.passport.user.profile.points = points;
					app.SessionStore.set(sessionID, session);
					console.log ("INFO", "successfully saved user points");
				} else {
					console.log ("ERROR", "saving user points");
				}
			});
		}
		/* Delete user from from every room, do not know where he is :P */
		delete onlineUsers['study'][socket.handshake.user.email];
		delete onlineUsers['coding'][socket.handshake.user.email];
		delete onlineUsers['sumorobot'][socket.handshake.user.email];
		/* Update the online users for all users in every room */
		io.sockets.to('study').emit('users', onlineUsers['study']);
		io.sockets.to('coding').emit('users', onlineUsers['coding']);
		io.sockets.to('sumorobot').emit('users', onlineUsers['sumorobot']);
		/* TODO: When not a guest user, save the points */
	});
});

function startECodeServer(on,pe1,pe2) {

    var p1={
        email:pe1,
        code:"",
        socket:null,
        score:0
    };
    var p2={
        email:pe2,
        code:"",
        socket:null,
        score:0
    };

    var eSock = io.of('/' + on)
        .on('connection', function (socket) {
            //console.log("Threat detected")

            if(socket.handshake.user.email==p1.email){
                p1.socket=socket;
            }else{
                p2.socket=socket;
            }
            socket.on("recieveClientCode", function (data) {
                if(socket.handshake.user.email==p1.email){
                    p1.code=data.code;
                    p2.socket.emit("p2Status",{code:data.code});
                    console.log("emitted to"+p2.email);
                }else{
                    p2.code=data.code;
                    p1.socket.emit("p2Status",{code:data.code});
                    console.log("emitted to"+p1.email);
                }
            });

        });
}