import { IClient, IClientJoin, IDocumentMessage, IUser, MessageType } from "@prague/runtime-definitions";
import * as _ from "lodash";
import * as moniker from "moniker";
// tslint:disable-next-line:no-var-requires
const now = require("performance-now");
import * as core from "../../core";
import { IProducer } from "../../utils";
import { ContentPublisher } from "../contentPublisher";

export class KafkaOrdererConnection implements core.IOrdererConnection {
    public static async Create(
        existing: boolean,
        document: core.IDocument,
        producer: IProducer,
        tenantId: string,
        documentId: string,
        socket: core.IWebSocket,
        user: IUser,
        client: IClient,
        maxMessageSize: number,
        contentPublisher: ContentPublisher): Promise<KafkaOrdererConnection> {

        const clientId = moniker.choose();

        // Create the connection
        const connection = new KafkaOrdererConnection(
            existing,
            document,
            producer,
            tenantId,
            documentId,
            clientId,
            user,
            client,
            contentPublisher,
            maxMessageSize);

        // Bind the socket to the channels the connection will send to
        await Promise.all([
            socket.join(`${tenantId}/${documentId}`),
            socket.join(`client#${clientId}`)]);
        return connection;
    }

    public get parentBranch(): string {
        return this._parentBranch;
    }

    // tslint:disable:variable-name
    private _parentBranch: string;
    // tslint:enable:variable-name

    constructor(
        public readonly existing: boolean,
        document: core.IDocument,
        private producer: IProducer,
        private tenantId: string,
        private documentId: string,
        public readonly clientId: string,
        private user: IUser,
        private client: IClient,
        private contentPublisher: ContentPublisher,
        public readonly maxMessageSize: number) {

        this._parentBranch = document.parent ? document.parent.documentId : null;

        const clientDetail: IClientJoin = {
            clientId: this.clientId,
            detail: this.client,
        };

        const message: core.IRawOperationMessage = {
            clientId: null,
            documentId: this.documentId,
            operation: {
                clientSequenceNumber: -1,
                contents: clientDetail,
                referenceSequenceNumber: -1,
                traces: [],
                type: MessageType.ClientJoin,
            },
            tenantId: this.tenantId,
            timestamp: Date.now(),
            type: core.RawOperationType,
            user: this.user,
        };

        this.submitRawOperation(message);
    }

    public order(message: IDocumentMessage): void {
        const rawMessage: core.IRawOperationMessage = {
            clientId: this.clientId,
            documentId: this.documentId,
            operation: message,
            tenantId: this.tenantId,
            timestamp: Date.now(),
            type: core.RawOperationType,
            user: this.user,
        };

        this.submitRawOperation(rawMessage, true);
    }

    public disconnect() {
        const message: core.IRawOperationMessage = {
            clientId: null,
            documentId: this.documentId,
            operation: {
                clientSequenceNumber: -1,
                contents: this.clientId,
                referenceSequenceNumber: -1,
                traces: [],
                type: MessageType.ClientLeave,
            },
            tenantId: this.tenantId,
            timestamp: Date.now(),
            type: core.RawOperationType,
            user: this.user,
        };

        this.submitRawOperation(message);
    }

    private submitRawOperation(message: core.IRawOperationMessage, split?: boolean) {
        // Add trace
        const operation = message.operation as IDocumentMessage;
        if (operation && operation.traces) {
            operation.traces.push(
                {
                    action: "start",
                    service: "alfred",
                    timestamp: now(),
                });
        }

        // TODO (mdaumi)
        // Checking clientId is a hack for not to split deli generated client leave and noop messages.
        // Checking remotehelp is for TMZ to correctly parse the message.
        if (split && message.clientId !== null && message.operation.type !== "remoteHelp") {
            this.contentPublisher.publish({
                clientId: this.clientId,
                documentId: this.documentId,
                op: _.cloneDeep(message.operation),
                tenantId: this.tenantId,
            });
            message.operation.contents = null;
            const stringMessage = JSON.stringify(message);
            this.producer.send(stringMessage, this.documentId);
        } else {
            const stringMessage = JSON.stringify(message);
            this.producer.send(stringMessage, this.documentId);
        }
    }
}

export class KafkaOrderer implements core.IOrderer {
    public static async Create(
        storage: core.IDocumentStorage,
        producer: IProducer,
        tenantId: string,
        documentId: string,
        maxMessageSize: number,
        contentPublisher: ContentPublisher): Promise<KafkaOrderer> {

        const details = await storage.getOrCreateDocument(tenantId, documentId);
        return new KafkaOrderer(details, producer, tenantId, documentId, maxMessageSize, contentPublisher);
    }

    private existing: boolean;

    constructor(
        private details: core.IDocumentDetails,
        private producer: IProducer,
        private tenantId: string,
        private documentId: string,
        private maxMessageSize: number,
        private contentPublisher: ContentPublisher) {
        this.existing = details.existing;
    }

    public async connect(
        socket: core.IWebSocket,
        user: IUser,
        client: IClient): Promise<core.IOrdererConnection> {

        const connection = KafkaOrdererConnection.Create(
            this.existing,
            this.details.value,
            this.producer,
            this.tenantId,
            this.documentId,
            socket,
            user,
            client,
            this.maxMessageSize,
            this.contentPublisher);

        // document is now existing regardless of the original value
        this.existing = true;

        return connection;
    }

    public close() {
        return Promise.resolve();
    }
}

export class KafkaOrdererFactory {
    private ordererMap = new Map<string, Promise<core.IOrderer>>();

    constructor(
        private producer: IProducer,
        private storage: core.IDocumentStorage,
        private maxMessageSize: number,
        private contentPublisher?: ContentPublisher) {
    }

    public async create(tenantId: string, documentId: string): Promise<core.IOrderer> {
        const fullId = `${tenantId}/${documentId}`;
        if (!this.ordererMap.has(fullId)) {
            const orderer = KafkaOrderer.Create(
                this.storage,
                this.producer,
                tenantId,
                documentId,
                this.maxMessageSize,
                this.contentPublisher);
            this.ordererMap.set(fullId, orderer);
        }

        return this.ordererMap.get(fullId);
    }
}
