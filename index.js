const github = require("@actions/github");
const core = require("@actions/core");
const graphql = require("@octokit/graphql");

async function run() {
    const myToken = core.getInput("action-token");
    const projectUrl = core.getInput("project-url");
    const columnName = core.getInput("column-name");
    const labelName = core.getInput("label-name");
    const milestoneName = core.getInput("milestone-name");
    const ignoreList = core.getInput("columns-to-ignore");
    const octokit = new github.GitHub(myToken);
    const context = github.context;

    if(!milestoneName && !labelName){
        throw new Error("one of label-name and milestone-name must be set");
    }
    else if (milestoneName && labelName){
        throw new Error("label-name and milestone-name cannot both be set");
    }

    var found = false;
    if(labelName){
        context.payload.pull_request.labels.forEach(function(item){
            if(labelName == item.name){
                found = true;
            }
        });
    }

    if(milestoneName){
        if(context.payload.pull_request.milestone && context.payload.pull_request.milestone.title == milestoneName){
            found = true;
        }
    }

    if(found){
        // get the columnId for the project where the pull request should be added/moved
        var info = await tryGetColumnAndCardInformation(columnName, projectUrl, myToken, context.payload.pull_request.id);
        var columnId = info[0];
        var cardId = info[1];
        var currentColumn = info[2];
        console.log(`columnId is: ${columnId}, cardId is: ${cardId}, currentColumn is: ${currentColumn}`);

        var skip = [];
        // Check optionally specified ignoreList
        if (ignoreList){
            skip = ignoreList.split(",");
        }

        if (cardId != null && (ignoreList == "*" || skip.includes(currentColumn))){
            // card is present in a column that we want to ignore, don't move or do anything
            return `Card exists for pull request in column ${currentColumn}. Column specified to be ignored, not moving pull request.`;
        }
        else if (cardId != null){
            // card already exists for the pull request
            // move card to the appropriate column
            return await moveExistingCard(octokit, columnId, cardId);
        } else {
            // card is not present
            // create new card in the appropriate column
            return await createNewCard(octokit, columnId, context.payload.pull_request.id);
        }
    } else {
        // None of the labels match what we are looking for, non-indicative of a failure though
        return `Issue #${context.payload.pull_request.id} does not have a label that matches ${labelName}, ignoring`;
    }
}

async function createNewCard(octokit, columnId, prId){
    console.log(`No card exists for the labeled pull request in the project. Attempting to create a card in column ${columnId}, for an pull request with the corresponding id #${prId}`);
    await octokit.projects.createCard({
        column_id: columnId,
        content_id: prId,
        content_type: "PullRequest"
    });
    return `Successfully created a new card in column #${columnId} for an pull request with the corresponding id:${prId} !`;
}

async function moveExistingCard(octokit, columnId, cardId){
    console.log(`A card already exists for the pull request. Attempting to move card #${cardId} to column #${columnId}`);
    await octokit.projects.moveCard({
        card_id: cardId,
        position: "bottom",
        column_id: columnId
    });
    return `Succesfully moved card #${cardId} to column #${columnId} !`;
}

async function tryGetColumnAndCardInformation(columnName, projectUrl, token, prDatabaseId){
    // if org project, we need to extract the org name
    // if repo project, need repo owner and name
    var columnId = null;
    var cardId = null;
    var currentColumnName = null;
    var splitUrl = projectUrl.split("/");
    var projectNumber = parseInt(splitUrl[6], 10);

    // check if repo or org project
    if(splitUrl[3] == "orgs"){
        // Org url will be in the format: https://github.com/orgs/github/projects/910
        var orgLogin = splitUrl[4];
        console.log(`This project is configured at the org level. Org Login:${orgLogin}, project number#${projectNumber}`);
        var orgInformation = await getOrgInformation(orgLogin, projectNumber, token);
        orgInformation.organization.project.columns.nodes.forEach(function(columnNode){
            var name = columnNode.name;
            if(name == columnName){
                columnId = columnNode.databaseId;
            }
            // check each column if there is a card that exists for the pull request
            columnNode.cards.edges.forEach(function(card){
                // card level
                if (card.node.content != null){
                    // only pull requests and pull requests have content
                    if(card.node.content.databaseId == prDatabaseId){
                        cardId = card.node.databaseId;
                        currentColumnName = columnNode.name;
                    }
                }
            });
        });
    } else {
        // Repo url will be in the format: https://github.com/bbq-beets/konradpabjan-test/projects/1
        var repoOwner = splitUrl[3];
        var repoName = splitUrl[4];
        console.log(`This project is configured at the repo level. Repo Owner:${repoOwner}, repo name:${repoName} project number#${projectNumber}`);
        var repoColumnInfo = await getRepoInformation(repoOwner, repoName, projectNumber, token);
        repoColumnInfo.repository.project.columns.nodes.forEach(function(columnNode){
            var name = columnNode.name;
            if(name == columnName){
                columnId = columnNode.databaseId;
            }
            // check each column if there is a card that exists for the pull request
            columnNode.cards.edges.forEach(function(card){
                // card level
                if (card.node.content != null){
                    // only pull requests and pull requests have content
                    if(card.node.content.databaseId == prDatabaseId){
                        cardId = card.node.databaseId;
                        currentColumnName = columnNode.name;
                    }
                }
            });
        });
    }
    return [columnId, cardId, currentColumnName];
}

async function getOrgInformation(organizationLogin, projectNumber, token){
    // GraphQL query to get all of the cards in each column for a project
    // https://developer.github.com/v4/explorer/ is good to play around with
    const response = await graphql(
        `query ($loginVariable: String!, $projectVariable: Int!){
            organization(login:$loginVariable) {
                name
                project(number:$projectVariable) {
                    databaseId
                    name
                    url
                    columns(first:100){
                        nodes{
                            databaseId
                            name
                            cards {
                                edges {
                                    node {
                                        databaseId
                                            content {
                                                ... on PullRequest {
                                                    databaseId
                                                    number
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }`,{
            loginVariable: organizationLogin,
            projectVariable: projectNumber,
            headers: {
                authorization: `bearer ${token}`
            }
        });
    return response;
}

async function getRepoInformation(repositoryOwner, repositoryName, projectNumber, token){
    // GraphQL query to get all of the columns in a project that is setup at that org level
    // https://developer.github.com/v4/explorer/ is good to play around with
    const response = await graphql(
        `query ($ownerVariable: String!, $nameVariable: String!, $projectVariable: Int!){
            repository(owner:$ownerVariable, name:$nameVariable) {
                project(number:$projectVariable){
                    id
                    number
                    databaseId
                    name
                    url
                    columns(first:100){
                        nodes{
                            databaseId
                            name
                            cards {
                                edges {
                                    node {
                                        databaseId
                                            content {
                                                ... on PullRequest {
                                                    databaseId
                                                    number
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }`, {
            ownerVariable: repositoryOwner,
            nameVariable: repositoryName,
            projectVariable: projectNumber,
            headers: {
                authorization: `bearer ${token}`
            }
        });
    return response;
}

run()
    .then(
        (response) => { console.log(`Finished running: ${response}`); },
        (error) => {
            console.log(`#ERROR# ${error}`);
            process.exit(1);
        }
    );
