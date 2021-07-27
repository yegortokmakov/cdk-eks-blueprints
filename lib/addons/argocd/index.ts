import { HelmChart, KubernetesManifest } from "@aws-cdk/aws-eks";
import { ManagedPolicy } from "@aws-cdk/aws-iam";
import { SecretsManager } from "aws-sdk";

import { ClusterAddOn, ClusterInfo, ClusterPostDeploy } from "../../stacks/cluster-types";
import { Team } from "../../teams";
import * as yaml from 'yaml';

export interface ArgoApplicationRepository {
    /**
     * Expected to support helm style repo at the moment
     */
    repoUrl: string,

    /** 
     * Path within the repository 
     */
    path?: string,

    /**
     * Optional name for the bootstrap application
     */
    name?: string,

    /**
     * Secret from AWS Secrets Manager to import credentials to access the specified git repository.
     * The secret must exist in the same region and account where the stack will run. 
     */
    credentialsSecretName?: string,

    /**
     * Depending on credentials type the arn should either point to an SSH key (plain text value)
     * or a json file with username/password attributes.
     * For TOKEN type per ArgoCD documentation (https://argoproj.github.io/argo-cd/user-guide/private-repositories/) 
     * username can be any non-empty username and token value as password.
     */
    credentialsType?: "USERNAME" | "TOKEN" | "SSH"

}

/**
 * Configuration options for ArgoCD add-on.
 */
export interface ArgoCDAddOnProps {
    namespace?: string,
    /**
     * If provided, the addon will bootstrap the app or apps in the provided repository.
     * In general, the repo is expected to have the app of apps, which can enable to bootstrap all workloads,
     * after the infrastructure and team provisioning is complete. 
     */
    bootstrapRepo?: ArgoApplicationRepository
}

const argoDefaults: ArgoCDAddOnProps = {
    namespace: "argocd"
}
export class ArgoCDAddOn implements ClusterAddOn, ClusterPostDeploy {

    readonly options: ArgoCDAddOnProps;
    private chartNode: HelmChart;

    constructor(props?: ArgoCDAddOnProps) {
        this.options = { ...argoDefaults, ...props };
    }

    deploy(clusterInfo: ClusterInfo): void {

        let repo = "";

        if(this.options.bootstrapRepo) {
             repo = yaml.stringify(
                [{
                    url: this.options.bootstrapRepo.repoUrl,
                    sshPrivateKeySecret: {
                        name: "bootstrap-repo-secret1",
                        key: "sshPrivateKey"
                    }  
                }]
            );
            console.log(repo)
        }

        this.chartNode = clusterInfo.cluster.addHelmChart("argocd-addon", {
            chart: "argo-cd",
            release: "ssp-addon",
            repository: "https://argoproj.github.io/argo-helm",
            version: '3.10.0',
            namespace: this.options.namespace,
            values: {
                server: {
                    serviceAccount: {
                        create: false
                    },
                    config: {
                        repositories: repo
                    }
                }
            }
        });
    }

    postDeploy(clusterInfo: ClusterInfo, teams: Team[]): void {
        console.assert(teams != null);
        const appRepo = this.options.bootstrapRepo;
        if(!appRepo) {
            return;
        }
        if(appRepo.credentialsSecretName) {
            this.createSecretKey(clusterInfo, appRepo.credentialsSecretName);
        }

        const manifest = new KubernetesManifest(clusterInfo.cluster.stack, "bootstrap-app", {
            cluster: clusterInfo.cluster,
            manifest : [{
                apiVersion: "argoproj.io/v1alpha1",
                kind: "Application",
                metadata: {
                    name: appRepo.name ?? "bootstrap-apps",
                    namespace: this.options.namespace
                },
                spec: {
                    destination:{
                        namespace: "default", 
                        server: "https://kubernetes.default.svc"
                    },
                    project: "default",
                    source: {
                        helm: {
                            valueFiles: ["values.yaml"]
                        },
                        path: appRepo.path,
                        repoURL: appRepo.repoUrl,
                        targetRevision: "HEAD"
                    },
                    syncPolicy: {
                        automated: {}
                    }
                }
            }],
            overwrite: true,
            prune: true  
        });
        //
        // Make sure the bootstrap is only applied after successful ArgoCD installation.
        //
        manifest.node.addDependency(this.chartNode);
    }

    async createSecretKey(clusterInfo : ClusterInfo, secretName : string) {

        const appRepo = this.options.bootstrapRepo!;
        let credentials = { url: appRepo.repoUrl };

        const sa = clusterInfo.cluster.addServiceAccount('argo-cd-server',
            {name: "argocd-server", namespace: this.options.namespace});
        const secretPolicy = ManagedPolicy.fromAwsManagedPolicyName("SecretsManagerReadWrite");
        sa.role.addManagedPolicy(secretPolicy);

        const secretValue = await this.getSecretValue(secretName, clusterInfo.cluster.stack.region);

        switch(appRepo?.credentialsType) {
            case "SSH":
                credentials = {...credentials, ...{ sshPrivateKey: secretValue }};
                break;
            case "USERNAME":
            case "TOKEN": 
                credentials = {...credentials, ...JSON.parse(secretValue)};
                break;
        }

        const manifest = new KubernetesManifest(clusterInfo.cluster.stack, "argo-bootstrap-secret", {
            cluster: clusterInfo.cluster,
            manifest: [{
                apiVersion: "v1",
                kind: "Secret", 
                metadata: {
                  name: appRepo?.name?? "bootstrap-repo-secret",
                  namespace: this.options.namespace,
                  labels: {
                    "argocd.argoproj.io/secret-type": "repository"
                  }
                },
                stringData: credentials,
            }],
            overwrite: true,
            prune: true, 
            skipValidation: true
        });
        manifest.node.addDependency(this.chartNode);
    }

    async getSecretValue(secretName: string, region: string): Promise<string> {
        const secretManager = new SecretsManager({ region: region });
        let secretString = "";
        try {
            let response = await secretManager.getSecretValue({ SecretId: secretName }).promise();
            if (response) {
                if (response.SecretString) {
                    secretString = response.SecretString;
                } else if (response.SecretBinary) {
                    throw new Error(`Invalid secret format for ${secretName}. Expected string value, received binary.`);
                }
            }
            return secretString;
        } 
        catch (error) {
            console.log(error);
            throw error;
        }
    }
}