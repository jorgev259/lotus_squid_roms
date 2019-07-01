let requestCount = 0
let limit = 20
// const { get } = require('axios')

let locked = false

module.exports = {
  async reqs (client, db) {
    db.prepare('CREATE TABLE IF NOT EXISTS requests (user TEXT, request TEXT, msg TEXT, donator TEXT, hold INTEGER DEFAULT \'NO\', id INTEGER PRIMARY KEY AUTOINCREMENT)').run()

    db.prepare('CREATE TABLE IF NOT EXISTS request_log (user TEXT, request TEXT, valid TEXT, reason TEXT, timestamp DATETIME)').run()
    requestCount = db.prepare('SELECT COUNT(*) as count FROM requests WHERE donator = ? AND hold = ?').get('NO', 'NO').count
    if (requestCount >= limit) locked = true
  },
  commands: {
    refresh: {
      desc: 'Reposts all open requests.',
      usage: 'refresh',
      async execute (client, msg, param, db) {
        let ids = db.prepare('SELECT id FROM requests ORDER BY id ASC').all().map(e => e.id)
        runId(ids)

        function runId (ids) {
          if (!ids[0]) return
          let row = db.prepare('SELECT * FROM requests WHERE id = ?').get(ids[0])

          let info = {
            request: row.request,
            user: row.user,
            id: row.id,
            hold: row.hold === 'YES',
            donator: row.donator === 'YES'
          }
          sendEmbed(msg, db, info)
            .then(() => {
              ids.shift()
              runId(ids)
            })
        }
      }
    },

    hold: {
      desc: 'Marks a request as ON HOLD.',
      usage: 'hold [id] [reason]',
      async execute (client, msg, param, db) {
        if (!param[2]) return msg.channel.send('Incomplete command.')

        let req = db.prepare('SELECT request,msg,user,donator,hold,id FROM requests WHERE id=?').get(param[1])
        if (req.donator === 'YES') return msg.channel.send('Donator requests cannot be put on hold.')

        if (!req) return msg.channel.send(`Request not found.`)
        let reason = param.slice(2).join(' ')

        let info = {
          request: req.request,
          user: req.user,
          donator: req.donator,
          hold: true,
          id: req.id,
          msg: req.msg
        }

        db.prepare('UPDATE requests SET hold = ? WHERE id=?').run('YES', info.id)

        editEmbed(msg, db, info)
          .then(() => {
            msg.guild.channels.find(c => c.name === 'requests-log').send(`Request: ${req.request}\nBy: <@${req.user}>\nState: ON HOLD by ${msg.author}\nReason: ${reason}`)

            msg.guild.channels.find(c => c.name === 'requests-submission').send(`The request ${req.request} from <@${req.user}> has put ON HOLD.\nReason: ${reason}`)

            lock(msg, -1)
          })
          .catch(err => catchErr(msg, err))
      }
    },

    request: {
      desc: 'Request a soundtrack',
      usage: 'request [url or name]',
      async execute (client, msg, param, db) {
        if (!param[1]) return msg.channel.send('Please provide a url or name')

        let req = db.prepare('SELECT request FROM requests WHERE user=? AND hold=?').get(msg.author.id, 'NO')
        let donator = msg.member.roles.some(r => r.name === 'Donators')
        let owner = msg.member.roles.some(r => r.name === 'Owner')
        if (!(donator || owner) && req) return msg.channel.send(`The request '${req.request}' is still on place. Wait until its fulfilled or rejected.`)
        if (!(donator || owner) && requestCount >= limit) return msg.channel.send('There are too many open requests right now. Wait until slots are opened.')
        let name = param.slice(1).join(' ')

        let info = {
          request: name,
          user: msg.author.id,
          donator: donator
        }
        submit(msg, db, info)
      }
    },

    pending: {
      desc: 'Shows how many pending requests you have.',
      async execute (client, msg, param, db) {
        let id = 0
        if (msg.mentions.users.size > 0 && !msg.member.roles.some(r => r.name === 'Mods/News')) return msg.channel.send('Forbidden')
        else if (msg.mentions.users.size > 0) id = msg.mentions.users.first().id
        else id = msg.author.id

        let { count } = db.prepare('SELECT COUNT(*) as count FROM requests WHERE user=? AND hold=?').get(id, 'NO')
        let { countHold } = db.prepare('SELECT COUNT(*) as countHold FROM requests WHERE user=? AND hold=?').get(id, 'YES')
        msg.channel.send(`${id === msg.author.id ? 'Pending' : `${msg.mentions.users.first().tag}'s pending`} requests: ${count}\n` +
                         `${id === msg.author.id ? 'On Hold' : `${msg.mentions.users.first().tag}'s on hold`} requests: ${countHold}`)
      }
    },

    complete: {
      desc: 'Marks a request as completed.',
      usage: 'complete [id] [link] [direct link]',
      async execute (client, msg, param, db) {
        if (!param[2]) return msg.channel.send('Incomplete command.')

        let req = db.prepare('SELECT request,msg,user,donator,hold FROM requests WHERE id=?').get(param[1])

        if (!req) return msg.channel.send(`Request not found.`)

        let link = param[2]

        db.prepare('INSERT INTO request_log (user,request,valid,reason,direct,timestamp) VALUES (?,?,\'YES\',?,?,datetime(\'now\'))').run(req.user, req.request, param[3] || 'NONE', link)
        db.prepare('DELETE FROM requests WHERE id=?').run(param[1])
        lock(msg, req.donator === 'YES' || req.hold === 'YES' ? 0 : -1)

        msg.guild.channels.find(c => c.name === 'open-requests').messages.fetch(req.msg).then(async m => {
          await m.delete()
          msg.guild.channels.find(c => c.name === 'requests-log').send(`Request: ${req.request}\nBy: <@${req.user}>\nState: Completed by ${msg.author}\nLink: ${link}`)

          msg.guild.channels.find(c => c.name === 'last-added-soundtracks').send(`<@${req.user}> ${link}`)
          if (param[3]) msg.guild.channels.find(c => c.name === 'direct-links').send(`${req.request} ${param[3]}`)
        })
      }
    },

    reject: {
      desc: 'Marks a request as rejected',
      usage: 'reject [id] [reason]',
      async execute (client, msg, param, db) {
        if (!param[2]) return msg.channel.send('Incomplete command.')

        let req = db.prepare('SELECT request,msg,user,donator,hold FROM requests WHERE id=?').get(param[1])

        if (!req) return msg.channel.send(`Request not found.`)

        let reason = param.slice(2).join(' ')

        db.prepare('INSERT INTO request_log (user,request,valid,reason,direct,timestamp) VALUES (?,?,\'NO\',?,?,datetime(\'now\'))').run(req.user, req.request, reason, 'NONE')
        db.prepare('DELETE FROM requests WHERE id=?').run(param[1])
        lock(msg, req.donator === 'YES' || req.hold === 'YES' ? 0 : -1)

        msg.guild.channels.find(c => c.name === 'open-requests').messages.fetch(req.msg).then(async m => {
          await m.delete()
          msg.guild.channels.find(c => c.name === 'requests-log').send(`Request: ${req.request}\nBy: <@${req.user}>\nState: Rejected by ${msg.author}\nReason: ${reason}`)

          msg.guild.channels.find(c => c.name === 'requests-submission').send(`The request ${req.request} from <@${req.user}> has been rejected.\nReason: ${reason}`)
        })
      }
    }
  }
}

function submit (msg, db, info) {
  let donator = msg.member.roles.some(r => r.name === 'Donators')
  db.prepare('INSERT INTO requests (user,request,msg,donator) VALUES (?,?,?,?)').run(msg.author.id, info.request, 'PENDING', donator ? 'YES' : 'NO')
  let { id } = db.prepare('SELECT id FROM requests WHERE user=? AND request=? AND msg=?').get(msg.author.id, info.request, 'PENDING')

  info.id = id
  sendEmbed(msg, db, info)
    .then(() => {
      msg.channel.send('Request submitted.')

      lock(msg, donator ? 0 : 1)
    })
    .catch(err => catchErr(msg, err))
}

function sendEmbed (msg, db, info) {
  return new Promise(async (resolve, reject) => {
    let embed = {
      fields: [
        {
          'name': 'Request',
          'value': `${info.request}${info.hold ? ' **(ON HOLD)**' : ''}`
        },
        {
          'name': 'Requested by',
          'value': `<@${info.user}> / ${info.user}`,
          'inline': true
        },
        {
          'name': 'ID',
          'value': info.id,
          'inline': true
        }
      ],
      color: info.donator ? 0xedcd40 : 0x42bfed
    }
    msg.guild.channels.find(c => c.name === 'open-requests').send({ embed })
      .then(m => {
        db.prepare('UPDATE requests SET msg = ? WHERE id=?').run(m.id, info.id)
        resolve()
      })
  })
}

function editEmbed (msg, db, info) {
  return new Promise(async (resolve, reject) => {
    let embed = {
      fields: [
        {
          'name': 'Request',
          'value': `${info.request}${info.hold ? ' **(ON HOLD)**' : ''}`
        },
        {
          'name': 'Requested by',
          'value': `<@${info.user}> / ${info.user}`,
          'inline': true
        },
        {
          'name': 'ID',
          'value': info.id,
          'inline': true
        }
      ],
      color: info.donator ? 0xedcd40 : 0x42bfed
    }

    msg.guild.channels.find(c => c.name === 'open-requests').messages.fetch(info.msg).then(m => {
      m.edit({ embed })
        .then(m => {
          resolve()
        })
    })
  })
}

function catchErr (msg, err) {
  console.log(err)
  msg.channel.send('Something went wrong.')
}

function lock (msg, ammount) {
  let channel = msg.guild.channels.find(c => c.name === 'requests-submission')
  requestCount += ammount

  if (requestCount >= limit && !locked) {
    channel.send('No more requests allowed')
    channel.overwritePermissions({
      permissionOverwrites: [
        {
          id: msg.guild.roles.find(r => r.name === 'BOTs').id,
          allow: ['VIEW_CHANNEL', 'SEND_MESSAGES']
        },
        {
          id: msg.guild.roles.find(r => r.name === 'Donators').id,
          allow: ['VIEW_CHANNEL', 'SEND_MESSAGES']
        },
        {
          id: msg.guild.roles.find(r => r.name === 'Technicans').id,
          allow: ['VIEW_CHANNEL', 'SEND_MESSAGES']
        },
        {
          id: msg.guild.roles.find(r => r.name === 'Owner').id,
          allow: ['VIEW_CHANNEL', 'SEND_MESSAGES']
        },
        {
          id: msg.guild.id,
          deny: ['SEND_MESSAGES'],
          allow: ['VIEW_CHANNEL']
        }
      ],
      reason: 'Submission locking'
    }).then(() => { locked = true })
  } else if (requestCount === limit - 1 && locked) {
    channel.send('Requests open')
    channel.overwritePermissions({
      permissionOverwrites: [
        {
          id: msg.guild.id,
          allow: ['VIEW_CHANNEL', 'SEND_MESSAGES']
        }
      ],
      reason: 'Submission enabling'
    }).then(() => { locked = false })
  }
}
