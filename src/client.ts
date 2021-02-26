import { Client } from "pg";

export class DbClient {
	static connectedClient: DbClient;
	
	connection: Client;
	connected: boolean;

	stalledRequests: StalledDbRequest[] = [];

	constructor(configuration?) {
		this.connection = new Client(configuration);

		this.connection.on("error", () => this.reconnect());
		this.connection.on("end", () => this.reconnect());
	}

	async connect() {
		await this.connection.connect();

		this.connected = true;
	}

	async reconnect() {
		this.connected = false;

		this.connect().then(() => {
			while (this.stalledRequests.length) {
				const request = this.stalledRequests.pop();

				this.query(request.query, request.data);
			}
		});
	}

	async query(sql: string, params: any[]) {
		if (!this.connected) {
			const stalledRequest = new StalledDbRequest();
			stalledRequest.query = sql;
			stalledRequest.data = params;

			this.stalledRequests.push(stalledRequest);

			return new Promise(done => {
				stalledRequest.oncomplete = data => done(data);
			});
		}

		const names = Object.keys(params).sort().reverse();
		let data = [];

		if (process.env.VLQUERY_LOG_SQL) {
			console.log(sql);
		}

		for (let name of names) {
			sql = sql.split(`@${name}`).join(`$${data.length + 1}`);

			data.push(params[name]);
		}
		
		return (await this.connection.query(sql, params)).rows;
	}

	static async query(sql: string, params: any[]) {
		return this.connectedClient.query(sql, params);
	}
}

export class StalledDbRequest {
	query: string;
	data: any[];

	oncomplete(res) {}
}