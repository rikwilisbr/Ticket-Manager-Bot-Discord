import { writeFile } from 'fs/promises'
import { resolve } from 'path'
import ejs from 'ejs'
import { format } from 'date-fns'
// format(new Date(), "d/MM/yyy, hh:mm:ss a")
export async function generateHtml(html_data, file_name) {
    try {
        // Define data to pass to the EJS template
        const data = {
            title: html_data.title,
            rate: html_data.rate,
            user_id: html_data.username,
            ticket_id: html_data.ticket_id,
            create_date:  html_data.created_at,
            final_date:  html_data.closed_at,
            messages: html_data.messages
        }

        // Load and render the EJS template
        const templatePath = './src/template.ejs'
        const html = await ejs.renderFile(templatePath, data)

        // Convert the HTML string to a buffer
        const buffer = Buffer.from(html, 'utf-8')

        return buffer
    } catch (error) {
        console.error('Error generating HTML:', error)
        throw error
    }
}
