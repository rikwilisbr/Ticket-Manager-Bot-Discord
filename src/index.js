import { ChannelType, Client, Events, GatewayIntentBits, PermissionsBitField, REST, Routes, SlashCommandBuilder, Partials, AttachmentBuilder  } from 'discord.js'

import * as dotenv from 'dotenv'
import { nanoid } from 'nanoid'
import { PrismaClient } from '@prisma/client'
import { format } from 'date-fns'
import { generateHtml } from './generateHtml.js'

const prisma = new PrismaClient()

// Load environment variables from .env file
dotenv.config()

const TOKEN = process.env.DISCORD_TOKEN
const CLIENT_ID = process.env.DISCORD_CLIENT_ID

if (!TOKEN || !CLIENT_ID) {
    console.error('DISCORD_TOKEN, DISCORD_CLIENT_ID must be set in the .env file');
    process.exit(1);
}

const commands = [
    new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Create a new ticket.')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('The message of your ticket')
                .setRequired(true))
        .toJSON(),

    new SlashCommandBuilder()
        .setName('finish')
        .setDescription('Finish current ticket, this action can not be undoned.')
        .toJSON(),

    new SlashCommandBuilder()
        .setName('setup_ticket_channel')
        .setDescription('Setup a channel to create your tickets.')
        .addStringOption(option =>
            option.setName('channel_id')
                .setDescription('Insert the channel id.')
                .setRequired(true))
        .toJSON(),

    new SlashCommandBuilder()
        .setName('setup_moderator_role')
        .setDescription('Setup a role to handle open tickets.')
        .addStringOption(option =>
            option.setName('role')
                .setDescription('Insert the role')
                .setRequired(true))
        .toJSON(),

    new SlashCommandBuilder()
        .setName('setup_file_channel')
        .setDescription('Setup a channel to receive ticket history files.')
        .addStringOption(option =>
            option.setName('channel_id')
                .setDescription('Insert the channel id.')
                .setRequired(true))
        .toJSON(),
    ]

const rest = new REST({ version: '10' }).setToken(TOKEN)

async function loadCommands(){
    try {
        console.log('Started refreshing application (/) commands.')
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands })

        console.log('Successfully reloaded application (/) commands.')
    } catch (error) {
        console.error(error)
    }
}

async function handleNewGuild(guild){
    const payload = {
        guild_id: guild.id,
        guild_name: guild.name
    }

    await prisma.guild.create({data: payload})

     const systemChannel = guild.systemChannel
     if (systemChannel) {
         systemChannel.send('Hello! Thanks for adding me to your server! 😊');
     }
}

async function createTicket(client, interaction){
    const db_guild = await prisma.guild.findUnique({where: {guild_id: interaction.guild.id}})

    if(!db_guild.ticket_channel){
        interaction.reply(`You need to setup a ticket channel to create new tickets, use /setup_ticket_channel to create it.`)
        return
    }

    if(!db_guild.moderator_role){
        interaction.reply(`You need to setup a moderator role to manage tickets, use /setup_moderator_role to create it.`)
        return
    }

    if(interaction.channel.id !== db_guild.ticket_channel){
        const ticket_channel = await interaction.guild.channels.fetch(db_guild.ticket_channel)
        interaction.reply(`Tickets creation are only available on ${ticket_channel}`)
        return
    }
    

    const message = interaction.options.getString("message")
    const guild = interaction.guild
    const category_id = interaction.channel.parentId
    const ticket_id = `${interaction.user.username}-${nanoid(8)}`

    const privateChannel = await guild.channels.create({
        name: `OPEN-${ticket_id}`,
        type: ChannelType.GuildText,
        parent: category_id, 
        permissionOverwrites: [
            {
                id: guild.id, 
                deny: [PermissionsBitField.Flags.ViewChannel],
            },
            {
                id: interaction.user.id, 
                allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
            },
            {
                id: client.user.id, 
                allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
            },
            {
                id: db_guild.moderator_role, 
                allow: [PermissionsBitField.Flags.ViewChannel],
            }
        ],
    })

    const dbPayload = {
        ticket_id,
        discord_user_id: interaction.user.id,
        discord_channel_id: privateChannel.id,
        discord_guild_id: interaction.guild.id,
        discord_guild_name: interaction.guild.name
    }

    await prisma.ticket.create({data: dbPayload})

    await interaction.reply(`Your ticket was created successfully at: ${privateChannel}`);
    await privateChannel.send(`Ticket created by ${interaction.user}\n\n **message**:\n ${message}`)
}

async function finishTicket(client, interaction){
    const foundTicket = await prisma.ticket.findUnique({where: {discord_channel_id: interaction.channel.id}})

    if(!foundTicket){
        interaction.reply(`There's no ticket open in this channel`)
        return
    }

    await interaction.reply(`Ticket finished successfully.`);
    const feedbackMessage =  await interaction.channel.send(`Was your problem solved? <@${foundTicket.discord_user_id}>`)

    await feedbackMessage.react('👍')
    await feedbackMessage.react('👎')
        
}

async function proccessHtml(ticket, user, messages, rate, closed_at, guild){
    const file_name = `Ticket history ${ticket.ticket_id}`
    const html_payload = {
        title: file_name,
        rate,
        username: `${user.username}<${user.id}>`,
        ticket_id: ticket.ticket_id,
        created_at: format(ticket.created_at, "d/MM/yyy, hh:mm:ss a"),
        closed_at: format(closed_at, "d/MM/yyy, hh:mm:ss a"),
        messages: messages.map(e=> {
            return {
                ...e,
                created_at: format(e.created_at, "d/MM/yyy, hh:mm:ss a")
            }
        })
    }
   
    const file = await generateHtml(html_payload, `Ticket history ${ticket.ticket_id}.html`)
    await sendHtmlFile(file, file_name, guild, ticket)
}

async function sendHtmlFile(file, file_name, guild, ticket){
    const foundGuild = await prisma.guild.findUnique({where: {guild_id: guild.id},})
    if(foundGuild && foundGuild.files_channel){
        const file_channel = await guild.channels.fetch(foundGuild.files_channel)
        if(file_channel){
            const attachment = new AttachmentBuilder(file, {name: file_name + ".html"})
            await file_channel.send({
                content: `History from ticket ${ticket.ticket_id}` ,
                files: [attachment],
            })
        }
    }
}

async function setupTicketChannel(client, interaction){
    const message = interaction.options.getString("channel_id")

    const foundChannel = await interaction.guild.channels.fetch(message)

    if(!foundChannel){
        interaction.reply(`Channel with id ${message} not found`)
        return
    }

    await prisma.guild.update({where: {guild_id: interaction.guild.id}, data:{ticket_channel: message}})
    interaction.reply(`Success, bot is ready to receive tickets on channel ${foundChannel}`)
}

async function setupFileChannel(client, interaction){
    const message = interaction.options.getString("channel_id")

    const foundChannel = await interaction.guild.channels.fetch(message)

    if(!foundChannel){
        interaction.reply(`Channel with id ${message} not found`)
        return
    }

    await prisma.guild.update({where: {guild_id: interaction.guild.id}, data:{files_channel: message}})
    interaction.reply(`Success, bot is ready to send files on channel ${foundChannel}`)
}

async function setupModeratorRole(clinet, interaction){
    const message = interaction.options.getString("role")
    const role_id = message.slice(3, message.length -1)
    const foundRole = await interaction.guild.roles.fetch(role_id)

    if(!foundRole){
        interaction.reply(`Role ${message} not found`)
        return
    }

    await prisma.guild.update({where: {guild_id: interaction.guild.id}, data: {moderator_role: role_id}})
    interaction.reply(`Success, now ${message} are able to manage ticket channels`)
}

const commandsActions = {
    "ticket": createTicket,
    "finish": finishTicket,
    "setup_ticket_channel": setupTicketChannel,
    "setup_file_channel": setupFileChannel,
    "setup_moderator_role": setupModeratorRole
}

async function main(){
    try {
        await loadCommands()

        const client = new Client({ intents: [
            GatewayIntentBits.Guilds, 
            GatewayIntentBits.GuildMessages, 
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions,
        ],
        partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    })
        
        client.on(Events.ClientReady, readyClient => {
            console.log(`Logged in as ${readyClient.user.tag}!`)
        })
        
        client.on(Events.GuildCreate, async (guild)=>{
            await handleNewGuild(guild)
        })

        client.on(Events.GuildDelete, async (guild) =>{

            const foundTickets = await prisma.ticket.findMany({where: {discord_guild_id: guild.id}})
            await prisma.message.deleteMany({where: {discord_channel_id: {in: foundTickets.map(e=> e.discord_channel_id)}}})

            await prisma.ticket.deleteMany({where: {discord_guild_id: guild.id}})
            await prisma.guild.delete({where: {guild_id: guild.id}})
        })
        
        client.on(Events.InteractionCreate, async interaction => {
            if (!interaction.isChatInputCommand()) return
            
            const interaction_name = interaction.commandName
            const action = commandsActions[interaction_name]
            
            if(action){
                await action(client, interaction)
            }
        })

        client.on(Events.MessageCreate, async (message) => {
            const foundTickets = await prisma.ticket.findMany({where: {discord_guild_id: message.guild.id}})
            const foundChannel = foundTickets.find(e=> e.discord_channel_id === message.channel.id && e.isOpen)

            if(foundChannel){
                const dbPayload = {
                    content: message.content,
                    username: message.author.username,
                    discord_user_id: message.author.id,
                    discord_channel_id: message.channel.id
                }

                await prisma.message.create({data: dbPayload})
            }

        })

        client.on(Events.MessageReactionAdd, async (reaction, user) =>{
            if (user.bot) return

            const foundTickets = await prisma.ticket.findMany({where: {discord_guild_id: reaction.message.guild.id}})
            const foundCurrentTicket = foundTickets.find(e=> e.discord_channel_id === reaction.message.channel.id && e.isOpen)

            if(foundCurrentTicket){
                if(reaction.partial){
                    await reaction.fetch()
                }

                const channel = reaction.message.channel
                const channel_name = channel.name
                
                await channel.setName(channel_name.replace('open', 'closed'))
    
                if (reaction.emoji.name === '👍' || reaction.emoji.name === '👎'){
                    const rate = reaction.emoji.name === '👍' ? 'Positive' : 'Negative'

                    const closed_at = new Date()
                    await prisma.ticket.update({where: {ticket_id: foundCurrentTicket.ticket_id},data: {rate, closed_at, isOpen: false}})

                    await channel.send(`Thanks for your feedback, it's very important for us! ${user}\nThis channel will be deleted within 5 minutes! please save your ticket id: ${foundCurrentTicket.ticket_id}`)
                    
                    await channel.permissionOverwrites.edit(user, {
                        SendMessages: false,
                        AddReactions: false,
                    });

                   

                    const foundMessages = await prisma.message.findMany({where: {discord_channel_id: channel.id}})

                    await proccessHtml(foundCurrentTicket, user, foundMessages, rate, closed_at, reaction.message.guild)
                    
                    // timeout to delete channel
                    setTimeout(async ()=>{
                        await channel.delete()
                    }, 300_000)
                } 
            }
            
        })

       
        await client.login(TOKEN)
    } catch (error) {
        console.error('Error in bot setup:', error)
    }
}

main()


