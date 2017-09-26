"use strict"
/* globals require, process */
const PORT = process.env.PORT || 3000
const addr = `tcp://127.0.0.1:${PORT}`
const gallente = 500004
const discordWebhook = process.env.discord

const log = new (require("log"))()
const fetch = require("node-fetch")

const zmq = require("zeromq")
const sock = zmq.socket("sub")

log.info("Initializing system...")
// Build up the system IDs we care about for filtering later
fetch("https://esi.tech.ccp.is/dev/fw/systems/?datasource=tranquility")
	.then((res) => res.json())
	.then((data) => {
		return data
			.filter((system) => {
				return system["owner_faction_id"] === gallente || system["occupier_faction_id"] === gallente
			})
			.map((system) => system["solar_system_id"])
	})
	.then((systems) => {
		log.info("Systems to watch, ready...")

		sock.connect(addr)
		sock.subscribe("zkill")
		log.info("zeroMQ connected...")

		sock.on("message", handleMessages.bind(null, systems))
		log.info("waiting for messages...")

		process.on("SIGINT", () => {
			log.info("Service shutdown received...")
			sock.disconnect(addr)
			log.info("...Service shutdown complete")
		})
	})
	.catch(log.error)

function handleMessages(systems, topic, message) {
	const data = JSON.parse(message)
	const systemID = data.killmail.solarSystem.id
	const victim = data.killmail.victim
	const suspects = data.killmail.attackers
		.filter((attacker) => !!attacker.character)
		.map((attacker) => {
			return Object.assign({}, attacker.character, {"securityStatus": attacker.securityStatus || "unknown"})
		})
	const isGallenteSystem = systems.includes(systemID)

	if ( isGallenteSystem ) {
		log.debug(`received a message related to a Gallente system. KillID = ${data.killID} SystemID = ${systemID}`)
	}
	else {
		log.debug(`Skipped KillID = ${data.killID} SystemID = ${systemID}`)
	}

	// get victim data
	if (isGallenteSystem && victim.character) {
		const character = fetch(`https://esi.tech.ccp.is/dev/characters/${victim.character.id}/?datasource=tranquility`)
			.then((res) => res.json())
			.then((data) => {
				log.debug(`Victim sec status: ${data.security_status}`)
				return data
			})
			.catch((err) => {
				log.error(err)
			})

		const system = fetch(`https://esi.tech.ccp.is/dev/universe/systems/${systemID}/?datasource=tranquility&language=en-us`)
			.then((res) => res.json())
			.catch((err) => {
				log.error(err)
			})

		Promise.all([character, system])
			.then(([character, system]) => {
				if (character.security_status > -5) {
					log.debug(`Possible pirate activity detected in ${system.name}`)
					const suspectStrs = suspects.map((suspect) => `- ${getZkillCharacter(suspect)}`)

					fetch(discordWebhook, {
						"method": "POST",
						"headers": {
							"content-type": "application/json"
						},
						"body": JSON.stringify({
							"content": generateeDiscordMessage(
								system.name,
								systemID,
								getZkillCharacter(Object.assign({}, victim.character, { "securityStatus": character.security_status })),
								suspectStrs,
								data.killID
							)
						})
					})
						.then(res => res.status)
						.then((status) => log.debug(`discord says: ${status}`))
				}
			})
	}
}

function generateeDiscordMessage(system, systemID, victim, suspects, zkill) {
	return `------------------------------------------------------
**Possible pirate activity detected in ${system}** (<https://zkillboard.com/system/${systemID}/>)

Victim: ${victim}
Possible Suspects:
${suspects.join("\n")}

https://zkillboard.com/kill/${zkill}/
`
}

function getZkillCharacter(character) {
	const zkill = character.id ? `<https://zkillboard.com/character/${character.id}>` : ""
	const securityStatus = character.securityStatus ? `${character.securityStatus.toFixed(2)}` : "unknown"
	return `${character.name} (${securityStatus}) ${zkill}`
}
